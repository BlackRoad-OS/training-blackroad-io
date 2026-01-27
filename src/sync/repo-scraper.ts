/**
 * ⬛⬜🛣️ BlackRoad OS - Repository Scraper
 * Scrapes and syncs repository data for cohesiveness analysis
 */

import type { Env, RepoInfo, RepoStructure, FileInfo, RepoIssue, Job } from '../types';
import { Logger } from '../lib/logger';
import { registerExecutor } from '../jobs/executor';
import { parseList } from '../lib/utils';

interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface GitHubContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
  content?: string;
  encoding?: string;
}

export class RepoScraper {
  private env: Env;
  private logger: Logger;
  private githubApi = 'https://api.github.com';

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger.child({ component: 'RepoScraper' });
  }

  /**
   * Get monitored repositories
   */
  getMonitoredRepos(): string[] {
    return parseList(this.env.MONITORED_REPOS);
  }

  /**
   * Fetch repository info from GitHub
   */
  async fetchRepoInfo(repoFullName: string): Promise<RepoInfo | null> {
    try {
      const response = await this.githubFetch(`/repos/${repoFullName}`);
      if (!response.ok) {
        this.logger.error('Failed to fetch repo info', undefined, {
          repo: repoFullName,
          status: response.status,
        });
        return null;
      }

      const data = await response.json() as {
        name: string;
        full_name: string;
        html_url: string;
        default_branch: string;
      };

      return {
        name: data.name,
        fullName: data.full_name,
        url: data.html_url,
        defaultBranch: data.default_branch,
        issues: [],
      };
    } catch (error) {
      this.logger.error('Error fetching repo info', error, { repo: repoFullName });
      return null;
    }
  }

  /**
   * Fetch repository structure (files and directories)
   */
  async fetchRepoStructure(repoFullName: string, branch?: string): Promise<RepoStructure | null> {
    try {
      // Get repo info for default branch if not specified
      if (!branch) {
        const info = await this.fetchRepoInfo(repoFullName);
        branch = info?.defaultBranch || 'main';
      }

      // Get the tree recursively
      const response = await this.githubFetch(
        `/repos/${repoFullName}/git/trees/${branch}?recursive=1`
      );

      if (!response.ok) {
        this.logger.error('Failed to fetch repo tree', undefined, {
          repo: repoFullName,
          status: response.status,
        });
        return null;
      }

      const data = await response.json() as { tree: GitHubTreeItem[] };
      const tree = data.tree;

      const directories: string[] = [];
      const files: FileInfo[] = [];

      for (const item of tree) {
        if (item.type === 'tree') {
          directories.push(item.path);
        } else if (item.type === 'blob') {
          files.push({
            path: item.path,
            size: item.size || 0,
            sha: item.sha,
            type: this.classifyFile(item.path),
          });
        }
      }

      // Fetch specific config files
      const config = await this.fetchConfigFiles(repoFullName, branch, files);

      return {
        directories,
        files,
        dependencies: config.dependencies || {},
        scripts: config.scripts || {},
        workflows: files.filter(f => f.path.startsWith('.github/workflows/')).map(f => f.path),
        config: config.other || {},
      };
    } catch (error) {
      this.logger.error('Error fetching repo structure', error, { repo: repoFullName });
      return null;
    }
  }

  /**
   * Fetch and parse config files (package.json, wrangler.toml, etc.)
   */
  private async fetchConfigFiles(
    repoFullName: string,
    branch: string,
    files: FileInfo[]
  ): Promise<{
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    other?: Record<string, unknown>;
  }> {
    const result: {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      other?: Record<string, unknown>;
    } = {};

    // Check for package.json
    if (files.some(f => f.path === 'package.json')) {
      try {
        const content = await this.fetchFileContent(repoFullName, 'package.json', branch);
        if (content) {
          const pkg = JSON.parse(content) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            scripts?: Record<string, string>;
          };
          result.dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
          result.scripts = pkg.scripts;
        }
      } catch {
        this.logger.warn('Failed to parse package.json', { repo: repoFullName });
      }
    }

    // Check for other config files
    const configFiles = ['wrangler.toml', 'tsconfig.json', '.eslintrc.json'];
    result.other = {};

    for (const configFile of configFiles) {
      if (files.some(f => f.path === configFile)) {
        try {
          const content = await this.fetchFileContent(repoFullName, configFile, branch);
          if (content) {
            result.other[configFile] = configFile.endsWith('.json')
              ? JSON.parse(content)
              : content;
          }
        } catch {
          // Ignore parse errors for config files
        }
      }
    }

    return result;
  }

  /**
   * Fetch file content from GitHub
   */
  async fetchFileContent(repoFullName: string, path: string, branch?: string): Promise<string | null> {
    try {
      const ref = branch ? `?ref=${branch}` : '';
      const response = await this.githubFetch(`/repos/${repoFullName}/contents/${path}${ref}`);

      if (!response.ok) return null;

      const data = await response.json() as GitHubContent;

      if (data.encoding === 'base64' && data.content) {
        return atob(data.content.replace(/\n/g, ''));
      }

      return null;
    } catch (error) {
      this.logger.error('Error fetching file content', error, { repo: repoFullName, path });
      return null;
    }
  }

  /**
   * Sync a single repository
   */
  async syncRepo(repoFullName: string, force = false): Promise<RepoInfo | null> {
    this.logger.info('Syncing repository', { repo: repoFullName, force });

    // Check cache if not forcing
    if (!force) {
      const cached = await this.getCachedRepo(repoFullName);
      if (cached && this.isFresh(cached.lastSyncedAt)) {
        this.logger.debug('Using cached repo data', { repo: repoFullName });
        return cached;
      }
    }

    // Fetch fresh data
    const info = await this.fetchRepoInfo(repoFullName);
    if (!info) return null;

    const structure = await this.fetchRepoStructure(repoFullName, info.defaultBranch);
    if (structure) {
      info.structure = structure;
    }

    // Analyze for issues
    info.issues = await this.analyzeRepo(info);

    // Calculate cohesion score
    info.cohesionScore = this.calculateCohesionScore(info);

    // Update sync timestamp
    info.lastSyncedAt = new Date().toISOString();

    // Cache the result
    await this.cacheRepo(info);

    this.logger.info('Repository synced', {
      repo: repoFullName,
      filesCount: structure?.files.length || 0,
      issuesCount: info.issues.length,
      cohesionScore: info.cohesionScore,
    });

    return info;
  }

  /**
   * Sync all monitored repositories
   */
  async syncAllRepos(mode: 'full' | 'incremental' = 'incremental'): Promise<RepoInfo[]> {
    const repos = this.getMonitoredRepos();
    const results: RepoInfo[] = [];

    for (const repoName of repos) {
      const fullName = repoName.includes('/')
        ? repoName
        : `${this.env.BLACKROAD_ORG}/${repoName}`;

      const info = await this.syncRepo(fullName, mode === 'full');
      if (info) {
        results.push(info);
      }
    }

    return results;
  }

  /**
   * Analyze repository for issues
   */
  private async analyzeRepo(repo: RepoInfo): Promise<RepoIssue[]> {
    const issues: RepoIssue[] = [];

    if (!repo.structure) return issues;

    const files = repo.structure.files.map(f => f.path);

    // Check for missing essential files
    const essentialFiles = ['README.md', 'LICENSE', '.gitignore'];
    for (const file of essentialFiles) {
      if (!files.includes(file)) {
        issues.push({
          type: 'missing_file',
          severity: file === 'README.md' ? 'warning' : 'info',
          message: `Missing ${file}`,
          path: file,
          suggestion: `Add ${file} to the repository`,
          autoFixable: false,
        });
      }
    }

    // Check for package.json consistency
    if (repo.structure.dependencies) {
      const deps = repo.structure.dependencies;

      // Check for outdated or vulnerable patterns (simplified check)
      if (deps.typescript && !deps.typescript.startsWith('^5')) {
        issues.push({
          type: 'outdated_dependency',
          severity: 'warning',
          message: 'TypeScript version may be outdated',
          suggestion: 'Consider upgrading to TypeScript 5.x',
          autoFixable: true,
        });
      }
    }

    // Check for workflow files
    if (repo.structure.workflows.length === 0) {
      issues.push({
        type: 'missing_file',
        severity: 'warning',
        message: 'No GitHub Actions workflows found',
        path: '.github/workflows/',
        suggestion: 'Add CI/CD workflows for automated testing and deployment',
        autoFixable: false,
      });
    }

    // Check for wrangler.toml if this is a Workers project
    const isWorkersProject = files.some(f =>
      f.includes('worker') || f.includes('wrangler.toml')
    );
    if (isWorkersProject && !files.includes('wrangler.toml')) {
      issues.push({
        type: 'missing_file',
        severity: 'critical',
        message: 'Missing wrangler.toml for Cloudflare Workers project',
        path: 'wrangler.toml',
        suggestion: 'Add wrangler.toml configuration',
        autoFixable: false,
      });
    }

    return issues;
  }

  /**
   * Calculate cohesion score for a repository (0-1)
   */
  private calculateCohesionScore(repo: RepoInfo): number {
    let score = 1.0;

    if (!repo.structure) return 0.5;

    // Penalize for issues
    for (const issue of repo.issues) {
      switch (issue.severity) {
        case 'critical':
          score -= 0.2;
          break;
        case 'warning':
          score -= 0.1;
          break;
        case 'info':
          score -= 0.02;
          break;
      }
    }

    // Reward for having good structure
    if (repo.structure.files.some(f => f.path === 'package.json')) score += 0.05;
    if (repo.structure.files.some(f => f.path === 'tsconfig.json')) score += 0.05;
    if (repo.structure.workflows.length > 0) score += 0.1;
    if (repo.structure.files.some(f => f.path.includes('test'))) score += 0.05;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Classify file type based on path
   */
  private classifyFile(path: string): FileInfo['type'] {
    if (path.startsWith('.github/workflows/')) return 'workflow';
    if (path.endsWith('.md')) return 'docs';
    if (path.includes('test') || path.includes('spec')) return 'test';
    if (path.match(/\.(json|toml|yaml|yml|rc|config)$/)) return 'config';
    if (path.match(/\.(ts|js|tsx|jsx|py|go|rs)$/)) return 'source';
    return 'other';
  }

  /**
   * Check if cached data is still fresh (15 minutes)
   */
  private isFresh(lastSyncedAt?: string): boolean {
    if (!lastSyncedAt) return false;
    const syncTime = new Date(lastSyncedAt).getTime();
    return Date.now() - syncTime < 15 * 60 * 1000;
  }

  /**
   * Get cached repository data
   */
  private async getCachedRepo(repoFullName: string): Promise<RepoInfo | null> {
    const key = `repo:${repoFullName.replace('/', ':')}`;
    const data = await this.env.REPOS_KV.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Cache repository data
   */
  private async cacheRepo(repo: RepoInfo): Promise<void> {
    const key = `repo:${repo.fullName.replace('/', ':')}`;
    await this.env.REPOS_KV.put(key, JSON.stringify(repo), {
      expirationTtl: 3600, // 1 hour
    });
  }

  /**
   * Make an authenticated request to GitHub API
   */
  private async githubFetch(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BlackRoad-Workers/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (this.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${this.env.GITHUB_TOKEN}`;
    }

    return fetch(`${this.githubApi}${path}`, { headers });
  }
}

// ============================================================================
// REGISTER JOB EXECUTOR
// ============================================================================

registerExecutor('repo_sync', {
  async execute(job: Job, env: Env, logger: Logger): Promise<Record<string, unknown>> {
    const scraper = new RepoScraper(env, logger);
    const mode = (job.payload.mode as 'full' | 'incremental') || 'incremental';
    const specificRepo = job.payload.repo as string | undefined;

    if (specificRepo) {
      const fullName = specificRepo.includes('/')
        ? specificRepo
        : `${env.BLACKROAD_ORG}/${specificRepo}`;

      const repo = await scraper.syncRepo(fullName, mode === 'full');
      return {
        synced: repo ? 1 : 0,
        repos: repo ? [repo.fullName] : [],
        issues: repo?.issues.length || 0,
      };
    }

    const repos = await scraper.syncAllRepos(mode);

    return {
      synced: repos.length,
      repos: repos.map(r => r.fullName),
      totalIssues: repos.reduce((acc, r) => acc + r.issues.length, 0),
      averageCohesion: repos.length > 0
        ? repos.reduce((acc, r) => acc + (r.cohesionScore || 0), 0) / repos.length
        : 0,
    };
  },
});
