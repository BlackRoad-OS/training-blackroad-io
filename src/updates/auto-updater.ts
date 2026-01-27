/**
 * ⬛⬜🛣️ BlackRoad OS - Auto-Update System
 * Automatically propagates updates across repositories
 */

import type {
  Env,
  Job,
  PendingUpdate,
  UpdateConfig,
  UpdateType,
} from '../types';
import { Logger } from '../lib/logger';
import { RepoScraper } from '../sync/repo-scraper';
import { registerExecutor } from '../jobs/executor';
import { generateId, isWithinScheduleWindow } from '../lib/utils';
import { JobScheduler } from '../jobs/scheduler';

interface UpdatePattern {
  type: UpdateType;
  sourceFile: string;
  targetPattern: string;
  transform?: (content: string, targetRepo: string) => string;
}

export class AutoUpdater {
  private env: Env;
  private logger: Logger;
  private scraper: RepoScraper;

  // Files that should be kept in sync across repos
  private readonly syncPatterns: UpdatePattern[] = [
    {
      type: 'workflow',
      sourceFile: '.github/workflows/ci.yml',
      targetPattern: '.github/workflows/ci.yml',
    },
    {
      type: 'workflow',
      sourceFile: '.github/workflows/deploy.yml',
      targetPattern: '.github/workflows/deploy.yml',
    },
    {
      type: 'config',
      sourceFile: '.github/CODEOWNERS',
      targetPattern: '.github/CODEOWNERS',
    },
    {
      type: 'config',
      sourceFile: '.github/dependabot.yml',
      targetPattern: '.github/dependabot.yml',
    },
    {
      type: 'config',
      sourceFile: 'CONTRIBUTING.md',
      targetPattern: 'CONTRIBUTING.md',
    },
    {
      type: 'config',
      sourceFile: 'BLACKROAD_EMOJI_DICTIONARY.md',
      targetPattern: 'BLACKROAD_EMOJI_DICTIONARY.md',
    },
  ];

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger.child({ component: 'AutoUpdater' });
    this.scraper = new RepoScraper(env, logger);
  }

  /**
   * Get update configuration
   */
  async getConfig(): Promise<UpdateConfig> {
    const cached = await this.env.REPOS_KV.get('config:auto-update');
    if (cached) {
      return JSON.parse(cached);
    }

    // Default config
    return {
      enabled: this.env.ENABLE_AUTO_UPDATES === 'true',
      autoMerge: false,
      requireApproval: true,
      allowedUpdateTypes: ['workflow', 'config', 'documentation'],
      excludePatterns: ['*.lock', 'package-lock.json', 'yarn.lock'],
    };
  }

  /**
   * Save update configuration
   */
  async setConfig(config: Partial<UpdateConfig>): Promise<UpdateConfig> {
    const current = await this.getConfig();
    const updated = { ...current, ...config };
    await this.env.REPOS_KV.put('config:auto-update', JSON.stringify(updated));
    return updated;
  }

  /**
   * Check for available updates across repositories
   */
  async checkForUpdates(): Promise<PendingUpdate[]> {
    const config = await this.getConfig();
    if (!config.enabled) {
      this.logger.info('Auto-updates disabled');
      return [];
    }

    // Check schedule window if configured
    if (config.scheduleWindow && !isWithinScheduleWindow(config.scheduleWindow)) {
      this.logger.info('Outside update schedule window');
      return [];
    }

    const updates: PendingUpdate[] = [];
    const repos = await this.scraper.syncAllRepos('incremental');

    // Use training-blackroad-io as the source of truth
    const sourceRepo = repos.find(r => r.name === 'training-blackroad-io');
    if (!sourceRepo) {
      this.logger.warn('Source repository not found');
      return [];
    }

    // Check each sync pattern against all other repos
    for (const pattern of this.syncPatterns) {
      if (!config.allowedUpdateTypes.includes(pattern.type)) {
        continue;
      }

      const sourceContent = await this.scraper.fetchFileContent(
        sourceRepo.fullName,
        pattern.sourceFile,
        sourceRepo.defaultBranch
      );

      if (!sourceContent) {
        continue;
      }

      const sourceHash = await this.hashContent(sourceContent);

      for (const targetRepo of repos) {
        if (targetRepo.name === sourceRepo.name) continue;

        // Check if target has this file
        const targetContent = await this.scraper.fetchFileContent(
          targetRepo.fullName,
          pattern.targetPattern,
          targetRepo.defaultBranch
        );

        const needsUpdate = !targetContent || (await this.hashContent(targetContent)) !== sourceHash;

        if (needsUpdate) {
          const update: PendingUpdate = {
            id: generateId('upd'),
            type: pattern.type,
            repo: targetRepo.fullName,
            title: `Update ${pattern.targetPattern}`,
            description: targetContent
              ? `Sync ${pattern.targetPattern} from ${sourceRepo.name}`
              : `Add ${pattern.targetPattern} from ${sourceRepo.name}`,
            diff: this.generateDiff(targetContent || '', sourceContent),
            sourceRepo: sourceRepo.fullName,
            priority: pattern.type === 'workflow' ? 'high' : 'normal',
            createdAt: new Date().toISOString(),
            status: 'pending',
          };

          updates.push(update);
          await this.savePendingUpdate(update);
        }
      }
    }

    this.logger.info('Update check completed', { updatesFound: updates.length });
    return updates;
  }

  /**
   * Apply a pending update
   */
  async applyUpdate(updateId: string): Promise<{ success: boolean; error?: string; prUrl?: string }> {
    const update = await this.getPendingUpdate(updateId);
    if (!update) {
      return { success: false, error: 'Update not found' };
    }

    if (update.status !== 'pending' && update.status !== 'approved') {
      return { success: false, error: `Update is ${update.status}` };
    }

    try {
      // Create a pull request with the update
      const prUrl = await this.createUpdatePR(update);

      update.status = 'applied';
      await this.savePendingUpdate(update);

      this.logger.info('Update applied', { updateId, repo: update.repo, prUrl });
      return { success: true, prUrl };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      update.status = 'failed';
      await this.savePendingUpdate(update);

      this.logger.error('Failed to apply update', error, { updateId });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Create a pull request for the update
   */
  private async createUpdatePR(update: PendingUpdate): Promise<string> {
    const [owner, repo] = update.repo.split('/');
    const branchName = `blackroad-auto-update/${update.id}`;

    // Get default branch ref
    const refResponse = await this.githubFetch(`/repos/${update.repo}/git/refs/heads/main`);
    if (!refResponse.ok) {
      throw new Error('Failed to get default branch ref');
    }
    const refData = await refResponse.json() as { object: { sha: string } };
    const baseSha = refData.object.sha;

    // Create new branch
    const createBranchResponse = await this.githubFetch(`/repos/${update.repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      }),
    });

    if (!createBranchResponse.ok && createBranchResponse.status !== 422) {
      throw new Error('Failed to create branch');
    }

    // Get source file content
    const sourceContent = await this.scraper.fetchFileContent(
      update.sourceRepo!,
      update.title.replace('Update ', '')
    );

    if (!sourceContent) {
      throw new Error('Failed to get source content');
    }

    // Create or update file
    const filePath = update.title.replace('Update ', '');

    // Check if file exists
    const existingFile = await this.githubFetch(
      `/repos/${update.repo}/contents/${filePath}?ref=${branchName}`
    );
    const existingData = existingFile.ok
      ? await existingFile.json() as { sha: string }
      : null;

    const updateFileResponse = await this.githubFetch(
      `/repos/${update.repo}/contents/${filePath}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: `🔄 ${update.title}\n\n${update.description}`,
          content: btoa(sourceContent),
          branch: branchName,
          sha: existingData?.sha,
        }),
      }
    );

    if (!updateFileResponse.ok) {
      throw new Error('Failed to update file');
    }

    // Create pull request
    const prResponse = await this.githubFetch(`/repos/${update.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: `🔄 ${update.title}`,
        body: `## Auto-Update from BlackRoad Workers

${update.description}

### Source
- Repository: \`${update.sourceRepo}\`
- Type: \`${update.type}\`

### Changes
\`\`\`diff
${update.diff || 'No diff available'}
\`\`\`

---
*This PR was created automatically by the BlackRoad Auto-Update system.*
`,
        head: branchName,
        base: 'main',
      }),
    });

    if (!prResponse.ok) {
      throw new Error('Failed to create pull request');
    }

    const prData = await prResponse.json() as { html_url: string };
    return prData.html_url;
  }

  /**
   * Get a pending update by ID
   */
  async getPendingUpdate(updateId: string): Promise<PendingUpdate | null> {
    const data = await this.env.REPOS_KV.get(`update:${updateId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Save a pending update
   */
  private async savePendingUpdate(update: PendingUpdate): Promise<void> {
    await this.env.REPOS_KV.put(`update:${update.id}`, JSON.stringify(update), {
      expirationTtl: 86400 * 7, // 7 days
    });
  }

  /**
   * List pending updates
   */
  async listPendingUpdates(status?: PendingUpdate['status']): Promise<PendingUpdate[]> {
    const list = await this.env.REPOS_KV.list({ prefix: 'update:' });
    const updates: PendingUpdate[] = [];

    for (const key of list.keys) {
      const data = await this.env.REPOS_KV.get(key.name);
      if (data) {
        const update = JSON.parse(data) as PendingUpdate;
        if (!status || update.status === status) {
          updates.push(update);
        }
      }
    }

    return updates.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Generate a simple diff between two strings
   */
  private generateDiff(oldContent: string, newContent: string): string {
    if (!oldContent) {
      return newContent.split('\n').map(line => `+ ${line}`).join('\n');
    }

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diff: string[] = [];

    // Simple line-by-line diff
    const maxLines = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine === newLine) {
        diff.push(`  ${oldLine || ''}`);
      } else {
        if (oldLine !== undefined) {
          diff.push(`- ${oldLine}`);
        }
        if (newLine !== undefined) {
          diff.push(`+ ${newLine}`);
        }
      }
    }

    return diff.slice(0, 50).join('\n') + (diff.length > 50 ? '\n... (truncated)' : '');
  }

  /**
   * Hash content for comparison
   */
  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Make an authenticated request to GitHub API
   */
  private async githubFetch(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BlackRoad-Workers/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };

    if (this.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${this.env.GITHUB_TOKEN}`;
    }

    return fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
  }
}

// ============================================================================
// REGISTER JOB EXECUTOR
// ============================================================================

registerExecutor('auto_update', {
  async execute(job: Job, env: Env, logger: Logger): Promise<Record<string, unknown>> {
    const updater = new AutoUpdater(env, logger);

    // Check for updates
    const pendingUpdates = await updater.checkForUpdates();

    // Get config to see if we should auto-apply
    const config = await updater.getConfig();

    let appliedCount = 0;
    const appliedPRs: string[] = [];

    if (config.autoMerge && !config.requireApproval) {
      // Auto-apply all pending updates
      for (const update of pendingUpdates) {
        const result = await updater.applyUpdate(update.id);
        if (result.success && result.prUrl) {
          appliedCount++;
          appliedPRs.push(result.prUrl);
        }
      }
    }

    // Trigger self-healing if updates failed
    if (job.payload.force && appliedCount < pendingUpdates.length && env.ENABLE_SELF_HEALING === 'true') {
      const scheduler = new JobScheduler(env, logger);
      await scheduler.createJob('self_heal', {
        type: 'update_failure',
        pendingCount: pendingUpdates.length,
        appliedCount,
      }, {
        priority: 'normal',
        metadata: { triggeredBy: 'cascade', parentJobId: job.id },
      });
    }

    return {
      checked: true,
      pendingUpdates: pendingUpdates.length,
      applied: appliedCount,
      appliedPRs,
      autoMergeEnabled: config.autoMerge,
    };
  },
});
