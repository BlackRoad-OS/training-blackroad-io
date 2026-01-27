/**
 * ⬛⬜🛣️ BlackRoad OS - Cohesion Analyzer
 * Analyzes cross-repo consistency and generates recommendations
 */

import type {
  Env,
  RepoInfo,
  CohesionReport,
  CrossRepoIssue,
  Recommendation,
  Job,
} from '../types';
import { Logger } from '../lib/logger';
import { RepoScraper } from './repo-scraper';
import { registerExecutor } from '../jobs/executor';
import { calculateSimilarity } from '../lib/utils';

export class CohesionAnalyzer {
  private env: Env;
  private logger: Logger;
  private scraper: RepoScraper;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger.child({ component: 'CohesionAnalyzer' });
    this.scraper = new RepoScraper(env, logger);
  }

  /**
   * Run full cohesion analysis across all repos
   */
  async analyze(depth: 'quick' | 'standard' | 'comprehensive' = 'standard'): Promise<CohesionReport> {
    this.logger.info('Starting cohesion analysis', { depth });

    // Sync all repos first
    const repos = await this.scraper.syncAllRepos(depth === 'comprehensive' ? 'full' : 'incremental');

    // Analyze cross-repo issues
    const crossRepoIssues = this.findCrossRepoIssues(repos, depth);

    // Generate recommendations
    const recommendations = this.generateRecommendations(repos, crossRepoIssues);

    // Calculate overall score
    const overallScore = this.calculateOverallScore(repos, crossRepoIssues);

    const report: CohesionReport = {
      timestamp: new Date().toISOString(),
      overallScore,
      repos,
      crossRepoIssues,
      recommendations,
    };

    // Cache the report
    await this.env.REPOS_KV.put('cohesion:latest', JSON.stringify(report), {
      expirationTtl: 3600, // 1 hour
    });

    this.logger.info('Cohesion analysis complete', {
      overallScore,
      reposAnalyzed: repos.length,
      issuesFound: crossRepoIssues.length,
      recommendations: recommendations.length,
    });

    return report;
  }

  /**
   * Find issues that span multiple repositories
   */
  private findCrossRepoIssues(repos: RepoInfo[], depth: string): CrossRepoIssue[] {
    const issues: CrossRepoIssue[] = [];

    if (repos.length < 2) return issues;

    // Check for version mismatches in shared dependencies
    issues.push(...this.checkDependencyMismatches(repos));

    // Check for missing shared configurations
    issues.push(...this.checkMissingSharedConfigs(repos));

    // Check for inconsistent naming patterns
    if (depth !== 'quick') {
      issues.push(...this.checkNamingInconsistencies(repos));
    }

    // Check for broken cross-repo references
    if (depth === 'comprehensive') {
      issues.push(...this.checkBrokenReferences(repos));
    }

    return issues;
  }

  /**
   * Check for dependency version mismatches across repos
   */
  private checkDependencyMismatches(repos: RepoInfo[]): CrossRepoIssue[] {
    const issues: CrossRepoIssue[] = [];
    const depVersions: Map<string, Map<string, string[]>> = new Map();

    // Collect all dependency versions
    for (const repo of repos) {
      if (!repo.structure?.dependencies) continue;

      for (const [dep, version] of Object.entries(repo.structure.dependencies)) {
        if (!depVersions.has(dep)) {
          depVersions.set(dep, new Map());
        }
        const versionMap = depVersions.get(dep)!;
        if (!versionMap.has(version)) {
          versionMap.set(version, []);
        }
        versionMap.get(version)!.push(repo.name);
      }
    }

    // Find mismatches for important shared deps
    const criticalDeps = ['typescript', 'hono', 'wrangler', 'vitest', 'eslint'];

    for (const [dep, versions] of depVersions) {
      if (versions.size > 1 && criticalDeps.includes(dep)) {
        const affectedRepos = Array.from(versions.values()).flat();
        const versionList = Array.from(versions.keys()).join(', ');

        issues.push({
          type: 'version_mismatch',
          repos: affectedRepos,
          description: `Dependency '${dep}' has different versions across repos: ${versionList}`,
          impact: 'medium',
          resolution: `Align all repos to use the same version of '${dep}'`,
        });
      }
    }

    return issues;
  }

  /**
   * Check for missing shared configuration files
   */
  private checkMissingSharedConfigs(repos: RepoInfo[]): CrossRepoIssue[] {
    const issues: CrossRepoIssue[] = [];
    const sharedConfigs = [
      '.github/CODEOWNERS',
      '.github/dependabot.yml',
      'tsconfig.json',
      '.prettierrc',
      '.eslintrc.json',
    ];

    for (const config of sharedConfigs) {
      const reposWithConfig = repos.filter(r =>
        r.structure?.files.some(f => f.path === config)
      );
      const reposWithoutConfig = repos.filter(r =>
        !r.structure?.files.some(f => f.path === config)
      );

      // If more than half have it, flag those without
      if (reposWithConfig.length > repos.length / 2 && reposWithoutConfig.length > 0) {
        issues.push({
          type: 'missing_shared_config',
          repos: reposWithoutConfig.map(r => r.name),
          description: `Configuration '${config}' is missing in some repos but present in others`,
          impact: reposWithConfig.length > repos.length * 0.7 ? 'high' : 'medium',
          resolution: `Add '${config}' to ensure consistency`,
        });
      }
    }

    return issues;
  }

  /**
   * Check for inconsistent naming patterns
   */
  private checkNamingInconsistencies(repos: RepoInfo[]): CrossRepoIssue[] {
    const issues: CrossRepoIssue[] = [];

    // Check for mixed naming conventions in source files
    const namingPatterns = repos.map(repo => {
      const files = repo.structure?.files.filter(f => f.type === 'source') || [];
      const hasKebab = files.some(f => f.path.includes('-'));
      const hasCamel = files.some(f => /[a-z][A-Z]/.test(f.path));
      const hasSnake = files.some(f => f.path.includes('_'));

      return {
        repo: repo.name,
        patterns: { kebab: hasKebab, camel: hasCamel, snake: hasSnake },
      };
    });

    // Check if different repos use different patterns
    const patternsUsed = new Set<string>();
    for (const { patterns } of namingPatterns) {
      if (patterns.kebab) patternsUsed.add('kebab-case');
      if (patterns.camel) patternsUsed.add('camelCase');
      if (patterns.snake) patternsUsed.add('snake_case');
    }

    if (patternsUsed.size > 1) {
      issues.push({
        type: 'inconsistent_naming',
        repos: repos.map(r => r.name),
        description: `Multiple naming conventions detected: ${Array.from(patternsUsed).join(', ')}`,
        impact: 'low',
        resolution: 'Standardize file naming convention across all repos',
      });
    }

    return issues;
  }

  /**
   * Check for broken cross-repo references
   */
  private checkBrokenReferences(repos: RepoInfo[]): CrossRepoIssue[] {
    const issues: CrossRepoIssue[] = [];
    const repoNames = new Set(repos.map(r => r.name));

    // Check for references to other repos in package.json dependencies
    for (const repo of repos) {
      const deps = repo.structure?.dependencies || {};

      for (const [dep, version] of Object.entries(deps)) {
        // Check if it references a local/GitHub package
        if (version.includes('github:') || version.includes('file:')) {
          const referencedRepo = version.split('/').pop()?.split('#')[0];
          if (referencedRepo && repoNames.has(referencedRepo)) {
            // Verify the referenced repo has proper exports
            const targetRepo = repos.find(r => r.name === referencedRepo);
            if (targetRepo && !targetRepo.structure?.files.some(f => f.path === 'package.json')) {
              issues.push({
                type: 'broken_reference',
                repos: [repo.name, referencedRepo],
                description: `${repo.name} references ${referencedRepo} but it may not be a proper package`,
                impact: 'high',
                resolution: `Ensure ${referencedRepo} has proper package.json with exports`,
              });
            }
          }
        }
      }
    }

    return issues;
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(
    repos: RepoInfo[],
    crossRepoIssues: CrossRepoIssue[]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    let priority = 1;

    // High-impact cross-repo issues first
    for (const issue of crossRepoIssues.filter(i => i.impact === 'high')) {
      recommendations.push({
        priority: priority++,
        action: issue.resolution || `Fix ${issue.type}`,
        reason: issue.description,
        affectedRepos: issue.repos,
        estimatedEffort: 'small',
      });
    }

    // Check for repos without CI/CD
    const reposWithoutCI = repos.filter(r =>
      !r.structure?.workflows.length
    );
    if (reposWithoutCI.length > 0) {
      recommendations.push({
        priority: priority++,
        action: 'Add CI/CD workflows',
        reason: 'Repositories lack automated testing and deployment',
        affectedRepos: reposWithoutCI.map(r => r.name),
        estimatedEffort: 'medium',
      });
    }

    // Check for low cohesion scores
    const lowCohesionRepos = repos.filter(r => (r.cohesionScore || 0) < 0.7);
    if (lowCohesionRepos.length > 0) {
      recommendations.push({
        priority: priority++,
        action: 'Improve repository structure',
        reason: 'Some repositories have low cohesion scores indicating structural issues',
        affectedRepos: lowCohesionRepos.map(r => r.name),
        estimatedEffort: 'medium',
      });
    }

    // Medium-impact issues
    for (const issue of crossRepoIssues.filter(i => i.impact === 'medium')) {
      recommendations.push({
        priority: priority++,
        action: issue.resolution || `Address ${issue.type}`,
        reason: issue.description,
        affectedRepos: issue.repos,
        estimatedEffort: 'small',
      });
    }

    return recommendations;
  }

  /**
   * Calculate overall cohesion score
   */
  private calculateOverallScore(repos: RepoInfo[], crossRepoIssues: CrossRepoIssue[]): number {
    if (repos.length === 0) return 0;

    // Average of individual repo scores
    const avgRepoScore = repos.reduce((acc, r) => acc + (r.cohesionScore || 0.5), 0) / repos.length;

    // Penalty for cross-repo issues
    let crossRepoPenalty = 0;
    for (const issue of crossRepoIssues) {
      switch (issue.impact) {
        case 'high':
          crossRepoPenalty += 0.1;
          break;
        case 'medium':
          crossRepoPenalty += 0.05;
          break;
        case 'low':
          crossRepoPenalty += 0.02;
          break;
      }
    }

    return Math.max(0, Math.min(1, avgRepoScore - crossRepoPenalty));
  }

  /**
   * Get the latest cohesion report
   */
  async getLatestReport(): Promise<CohesionReport | null> {
    const data = await this.env.REPOS_KV.get('cohesion:latest');
    return data ? JSON.parse(data) : null;
  }
}

// ============================================================================
// REGISTER JOB EXECUTORS
// ============================================================================

registerExecutor('cohesion_check', {
  async execute(job: Job, env: Env, logger: Logger): Promise<Record<string, unknown>> {
    const analyzer = new CohesionAnalyzer(env, logger);
    const depth = (job.payload.depth as 'quick' | 'standard' | 'comprehensive') || 'standard';

    const report = await analyzer.analyze(depth);

    // Check if we need to trigger self-healing
    const threshold = parseFloat(env.COHESION_THRESHOLD || '0.85');
    if (report.overallScore < threshold && env.ENABLE_SELF_HEALING === 'true') {
      // Queue healing actions for critical issues
      for (const issue of report.crossRepoIssues.filter(i => i.impact === 'high')) {
        await env.HEALING_QUEUE.send({
          issueId: `cohesion_${issue.type}_${Date.now()}`,
          action: 'notify_admin',
          context: {
            issue,
            report: {
              overallScore: report.overallScore,
              timestamp: report.timestamp,
            },
          },
          attempt: 1,
        });
      }
    }

    return {
      overallScore: report.overallScore,
      reposAnalyzed: report.repos.length,
      crossRepoIssues: report.crossRepoIssues.length,
      recommendations: report.recommendations.length,
      belowThreshold: report.overallScore < threshold,
    };
  },
});

registerExecutor('deep_analysis', {
  async execute(job: Job, env: Env, logger: Logger): Promise<Record<string, unknown>> {
    const analyzer = new CohesionAnalyzer(env, logger);

    // Run comprehensive analysis
    const report = await analyzer.analyze('comprehensive');

    // Store in R2 for long-term retention
    const key = `reports/cohesion-${new Date().toISOString().split('T')[0]}.json`;
    await env.ARTIFACTS_BUCKET.put(key, JSON.stringify(report, null, 2), {
      customMetadata: {
        type: 'cohesion-report',
        score: report.overallScore.toString(),
      },
    });

    return {
      overallScore: report.overallScore,
      reposAnalyzed: report.repos.length,
      artifactKey: key,
      fullReport: job.payload.full ? report : undefined,
    };
  },
});
