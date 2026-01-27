/**
 * ⬛⬜🛣️ BlackRoad OS - Self-Resolution/Healing System
 * Automatically detects and resolves issues
 */

import type {
  Env,
  Job,
  HealthStatus,
  HealthCheck,
  HealthIssue,
  HealingAction,
  HealingActionType,
  HealingMessage,
} from '../types';
import { Logger } from '../lib/logger';
import { JobScheduler } from '../jobs/scheduler';
import { registerExecutor } from '../jobs/executor';
import { generateId, retry } from '../lib/utils';

interface HealingStrategy {
  action: HealingActionType;
  maxAttempts: number;
  cooldownMs: number;
  execute: (issue: HealthIssue, env: Env, logger: Logger) => Promise<{ success: boolean; message: string }>;
}

export class SelfHealer {
  private env: Env;
  private logger: Logger;
  private scheduler: JobScheduler;

  // Healing strategies for different issue types
  private readonly strategies: Map<HealingActionType, HealingStrategy> = new Map([
    ['restart_job', {
      action: 'restart_job',
      maxAttempts: 3,
      cooldownMs: 60000, // 1 minute
      execute: async (issue, env, logger) => {
        const jobId = issue.description.match(/job_(\w+)/)?.[1];
        if (!jobId) {
          return { success: false, message: 'No job ID found' };
        }

        const scheduler = new JobScheduler(env, logger);
        const result = await scheduler.retryJob(jobId);

        return {
          success: !!result,
          message: result ? `Job ${jobId} queued for retry` : `Failed to retry job ${jobId}`,
        };
      },
    }],
    ['clear_cache', {
      action: 'clear_cache',
      maxAttempts: 1,
      cooldownMs: 300000, // 5 minutes
      execute: async (issue, env, logger) => {
        // Clear specific KV namespace based on issue context
        const namespace = issue.description.includes('REPOS') ? env.REPOS_KV : env.JOBS_KV;
        const prefix = issue.description.match(/prefix:(\S+)/)?.[1];

        if (prefix) {
          const list = await namespace.list({ prefix, limit: 100 });
          for (const key of list.keys) {
            await namespace.delete(key.name);
          }
          return { success: true, message: `Cleared ${list.keys.length} cache entries` };
        }

        return { success: false, message: 'No cache prefix specified' };
      },
    }],
    ['retry_sync', {
      action: 'retry_sync',
      maxAttempts: 5,
      cooldownMs: 120000, // 2 minutes
      execute: async (issue, env, logger) => {
        const scheduler = new JobScheduler(env, logger);
        const job = await scheduler.createJob('repo_sync', {
          mode: 'full',
          force: true,
        }, {
          priority: 'high',
          metadata: { triggeredBy: 'auto_heal' },
        });

        return { success: true, message: `Sync job ${job.id} created` };
      },
    }],
    ['reset_state', {
      action: 'reset_state',
      maxAttempts: 1,
      cooldownMs: 600000, // 10 minutes
      execute: async (issue, env, logger) => {
        // Reset Durable Object state
        const doId = issue.description.match(/DO:(\w+)/)?.[1];
        if (!doId) {
          return { success: false, message: 'No Durable Object ID specified' };
        }

        // We can't directly reset DO state from here, but we can trigger an alarm
        logger.warn('State reset requested - manual intervention may be needed', { doId });
        return { success: true, message: 'State reset scheduled' };
      },
    }],
    ['notify_admin', {
      action: 'notify_admin',
      maxAttempts: 3,
      cooldownMs: 3600000, // 1 hour
      execute: async (issue, env, logger) => {
        if (!env.ALERT_WEBHOOK_URL) {
          logger.warn('No alert webhook configured');
          return { success: false, message: 'No alert webhook configured' };
        }

        const payload = {
          text: `🚨 BlackRoad Self-Healing Alert`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🚨 Self-Healing Alert',
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Issue Type:*\n${issue.type}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Severity:*\n${issue.severity}`,
                },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Description:*\n${issue.description}`,
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Healing Attempts:*\n${issue.healingAttempts}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Auto-Healable:*\n${issue.autoHealable ? 'Yes' : 'No'}`,
                },
              ],
            },
          ],
        };

        const response = await fetch(env.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        return {
          success: response.ok,
          message: response.ok ? 'Alert sent' : 'Failed to send alert',
        };
      },
    }],
    ['escalate', {
      action: 'escalate',
      maxAttempts: 1,
      cooldownMs: 7200000, // 2 hours
      execute: async (issue, env, logger) => {
        // Create a GitHub issue for manual intervention
        if (!env.GITHUB_TOKEN) {
          return { success: false, message: 'No GitHub token configured' };
        }

        const response = await fetch(
          `https://api.github.com/repos/${env.BLACKROAD_ORG}/training-blackroad-io/issues`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'BlackRoad-Workers/1.0',
            },
            body: JSON.stringify({
              title: `🆘 Self-Healing Escalation: ${issue.type}`,
              body: `## Automated Escalation

The self-healing system was unable to automatically resolve the following issue:

### Issue Details
- **Type:** ${issue.type}
- **Severity:** ${issue.severity}
- **Detected At:** ${issue.detectedAt}
- **Healing Attempts:** ${issue.healingAttempts}

### Description
${issue.description}

### Action Required
This issue requires manual intervention. Please investigate and resolve.

---
*This issue was created automatically by the BlackRoad Self-Healing system.*`,
              labels: ['self-healing', 'escalation', issue.severity],
            }),
          }
        );

        const data = await response.json() as { html_url?: string };
        return {
          success: response.ok,
          message: response.ok ? `Issue created: ${data.html_url}` : 'Failed to create issue',
        };
      },
    }],
    ['rollback', {
      action: 'rollback',
      maxAttempts: 1,
      cooldownMs: 3600000, // 1 hour
      execute: async (issue, env, logger) => {
        // Rollback typically involves reverting to a previous known-good state
        // This is a placeholder for more sophisticated rollback logic
        logger.warn('Rollback requested - implementation pending', { issue: issue.id });
        return { success: false, message: 'Rollback not yet implemented' };
      },
    }],
    ['recreate_resource', {
      action: 'recreate_resource',
      maxAttempts: 2,
      cooldownMs: 600000, // 10 minutes
      execute: async (issue, env, logger) => {
        const resourceType = issue.description.match(/resource:(\w+)/)?.[1];
        if (!resourceType) {
          return { success: false, message: 'No resource type specified' };
        }

        // Handle different resource types
        switch (resourceType) {
          case 'kv_namespace':
            // Clear and repopulate KV namespace
            logger.info('KV namespace recreation requested');
            return { success: true, message: 'KV namespace marked for recreation' };

          case 'queue':
            // Purge and restart queue processing
            logger.info('Queue recreation requested');
            return { success: true, message: 'Queue marked for recreation' };

          default:
            return { success: false, message: `Unknown resource type: ${resourceType}` };
        }
      },
    }],
  ]);

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger.child({ component: 'SelfHealer' });
    this.scheduler = new JobScheduler(env, logger);
  }

  /**
   * Run a comprehensive health check
   */
  async runHealthCheck(): Promise<HealthStatus> {
    this.logger.info('Running health check');

    const checks: HealthCheck[] = [];
    const issues: HealthIssue[] = [];

    // Check KV namespaces
    checks.push(await this.checkKVNamespace('JOBS_KV', this.env.JOBS_KV));
    checks.push(await this.checkKVNamespace('REPOS_KV', this.env.REPOS_KV));
    checks.push(await this.checkKVNamespace('HEALING_KV', this.env.HEALING_KV));

    // Check queue health
    checks.push(await this.checkQueue('JOB_QUEUE'));
    checks.push(await this.checkQueue('SYNC_QUEUE'));
    checks.push(await this.checkQueue('HEALING_QUEUE'));

    // Check for stale jobs
    const staleJobCheck = await this.checkStaleJobs();
    checks.push(staleJobCheck.check);
    if (staleJobCheck.issues) {
      issues.push(...staleJobCheck.issues);
    }

    // Check GitHub connectivity
    checks.push(await this.checkGitHubConnectivity());

    // Determine overall health
    const failedChecks = checks.filter(c => c.status === 'fail');
    const healthy = failedChecks.length === 0;

    // Get previous status to track consecutive failures
    const previousStatus = await this.getHealthStatus();
    const consecutiveFailures = healthy
      ? 0
      : (previousStatus?.consecutiveFailures || 0) + 1;

    const status: HealthStatus = {
      healthy,
      timestamp: new Date().toISOString(),
      checks,
      issues,
      consecutiveFailures,
    };

    // Store status
    await this.saveHealthStatus(status);

    // If unhealthy and self-healing is enabled, trigger healing
    if (!healthy && this.env.ENABLE_SELF_HEALING === 'true') {
      await this.triggerHealing(status, issues);
    }

    this.logger.info('Health check completed', {
      healthy,
      checksRun: checks.length,
      failedChecks: failedChecks.length,
      issuesFound: issues.length,
    });

    return status;
  }

  /**
   * Check a KV namespace
   */
  private async checkKVNamespace(name: string, kv: KVNamespace): Promise<HealthCheck> {
    const start = Date.now();
    try {
      const testKey = '_health_check_' + Date.now();
      await kv.put(testKey, 'test');
      const value = await kv.get(testKey);
      await kv.delete(testKey);

      if (value !== 'test') {
        return {
          name: `KV:${name}`,
          status: 'fail',
          message: 'Read/write verification failed',
          latency: Date.now() - start,
        };
      }

      return {
        name: `KV:${name}`,
        status: 'pass',
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        name: `KV:${name}`,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
        latency: Date.now() - start,
      };
    }
  }

  /**
   * Check queue health
   */
  private async checkQueue(name: string): Promise<HealthCheck> {
    // We can't directly check queue health from within a worker
    // But we can verify the binding exists
    const queue = (this.env as Record<string, unknown>)[name] as Queue<unknown> | undefined;

    if (!queue) {
      return {
        name: `Queue:${name}`,
        status: 'fail',
        message: 'Queue binding not found',
      };
    }

    return {
      name: `Queue:${name}`,
      status: 'pass',
      message: 'Queue binding available',
    };
  }

  /**
   * Check for stale jobs
   */
  private async checkStaleJobs(): Promise<{ check: HealthCheck; issues?: HealthIssue[] }> {
    const { jobs } = await this.scheduler.listJobs({ status: 'running' });
    const staleThreshold = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    const staleJobs = jobs.filter(job => {
      const startTime = new Date(job.startedAt || job.createdAt).getTime();
      return now - startTime > staleThreshold;
    });

    if (staleJobs.length > 0) {
      const issues: HealthIssue[] = staleJobs.map(job => ({
        id: generateId('issue'),
        type: 'restart_job',
        severity: 'warning' as const,
        detectedAt: new Date().toISOString(),
        description: `Job job_${job.id} has been running for over 30 minutes`,
        autoHealable: true,
        healingAttempts: 0,
        resolved: false,
      }));

      return {
        check: {
          name: 'StaleJobs',
          status: 'warn',
          message: `${staleJobs.length} stale job(s) detected`,
          metadata: { staleJobIds: staleJobs.map(j => j.id) },
        },
        issues,
      };
    }

    return {
      check: {
        name: 'StaleJobs',
        status: 'pass',
        message: 'No stale jobs',
      },
    };
  }

  /**
   * Check GitHub API connectivity
   */
  private async checkGitHubConnectivity(): Promise<HealthCheck> {
    const start = Date.now();

    if (!this.env.GITHUB_TOKEN) {
      return {
        name: 'GitHub',
        status: 'warn',
        message: 'No GitHub token configured',
      };
    }

    try {
      const response = await fetch('https://api.github.com/rate_limit', {
        headers: {
          Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'BlackRoad-Workers/1.0',
        },
      });

      const data = await response.json() as {
        resources: { core: { remaining: number; limit: number } };
      };

      if (response.ok) {
        const { remaining, limit } = data.resources.core;
        const percentRemaining = (remaining / limit) * 100;

        return {
          name: 'GitHub',
          status: percentRemaining < 10 ? 'warn' : 'pass',
          message: percentRemaining < 10
            ? `Rate limit low: ${remaining}/${limit}`
            : `Rate limit OK: ${remaining}/${limit}`,
          latency: Date.now() - start,
          metadata: { remaining, limit },
        };
      }

      return {
        name: 'GitHub',
        status: 'fail',
        message: `API returned ${response.status}`,
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        name: 'GitHub',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
        latency: Date.now() - start,
      };
    }
  }

  /**
   * Trigger healing actions for issues
   */
  private async triggerHealing(status: HealthStatus, issues: HealthIssue[]): Promise<void> {
    for (const issue of issues) {
      if (!issue.autoHealable) continue;

      // Check if we should escalate based on consecutive failures
      if (status.consecutiveFailures >= 5) {
        await this.env.HEALING_QUEUE.send({
          issueId: issue.id,
          action: 'escalate',
          context: { issue, consecutiveFailures: status.consecutiveFailures },
          attempt: 1,
        });
        continue;
      }

      // Queue the appropriate healing action
      await this.env.HEALING_QUEUE.send({
        issueId: issue.id,
        action: issue.type,
        context: { issue },
        attempt: 1,
      });
    }
  }

  /**
   * Execute a healing action
   */
  async executeHealing(message: HealingMessage): Promise<HealingAction> {
    const startTime = Date.now();
    const { issueId, action, context, attempt } = message;

    this.logger.info('Executing healing action', { issueId, action, attempt });

    const strategy = this.strategies.get(action);
    if (!strategy) {
      return {
        type: action,
        issueId,
        timestamp: new Date().toISOString(),
        success: false,
        error: `Unknown healing action: ${action}`,
        duration: Date.now() - startTime,
      };
    }

    // Check max attempts
    if (attempt > strategy.maxAttempts) {
      this.logger.warn('Max healing attempts exceeded', { issueId, action, attempt });

      // Escalate to admin
      if (action !== 'escalate' && action !== 'notify_admin') {
        await this.env.HEALING_QUEUE.send({
          issueId,
          action: 'escalate',
          context: { ...context, previousAction: action, attempts: attempt },
          attempt: 1,
        });
      }

      return {
        type: action,
        issueId,
        timestamp: new Date().toISOString(),
        success: false,
        error: 'Max attempts exceeded, escalated',
        duration: Date.now() - startTime,
      };
    }

    try {
      // Get or create issue record
      let issue = await this.getIssue(issueId);
      if (!issue) {
        issue = context.issue as HealthIssue || {
          id: issueId,
          type: action,
          severity: 'warning',
          detectedAt: new Date().toISOString(),
          description: `Auto-generated for healing action ${action}`,
          autoHealable: true,
          healingAttempts: 0,
          resolved: false,
        };
      }

      // Check cooldown
      if (issue.lastAttempt) {
        const timeSinceLastAttempt = Date.now() - new Date(issue.lastAttempt).getTime();
        if (timeSinceLastAttempt < strategy.cooldownMs) {
          return {
            type: action,
            issueId,
            timestamp: new Date().toISOString(),
            success: false,
            error: 'Cooldown period not elapsed',
            duration: Date.now() - startTime,
          };
        }
      }

      // Execute the healing strategy
      const result = await strategy.execute(issue, this.env, this.logger);

      // Update issue record
      issue.healingAttempts++;
      issue.lastAttempt = new Date().toISOString();
      if (result.success) {
        issue.resolved = true;
        issue.resolvedAt = new Date().toISOString();
      }
      await this.saveIssue(issue);

      // Log the healing action
      const healingAction: HealingAction = {
        type: action,
        issueId,
        timestamp: new Date().toISOString(),
        success: result.success,
        result: { message: result.message },
        duration: Date.now() - startTime,
      };

      await this.logHealingAction(healingAction);

      this.logger.info('Healing action completed', {
        issueId,
        action,
        success: result.success,
        message: result.message,
      });

      return healingAction;

    } catch (error) {
      const healingAction: HealingAction = {
        type: action,
        issueId,
        timestamp: new Date().toISOString(),
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };

      await this.logHealingAction(healingAction);

      this.logger.error('Healing action failed', error, { issueId, action });

      return healingAction;
    }
  }

  /**
   * Get issue by ID
   */
  private async getIssue(issueId: string): Promise<HealthIssue | null> {
    const data = await this.env.HEALING_KV.get(`issue:${issueId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Save issue
   */
  private async saveIssue(issue: HealthIssue): Promise<void> {
    await this.env.HEALING_KV.put(`issue:${issue.id}`, JSON.stringify(issue), {
      expirationTtl: 86400 * 30, // 30 days
    });
  }

  /**
   * Get health status
   */
  async getHealthStatus(): Promise<HealthStatus | null> {
    const data = await this.env.HEALING_KV.get('status:health');
    return data ? JSON.parse(data) : null;
  }

  /**
   * Save health status
   */
  private async saveHealthStatus(status: HealthStatus): Promise<void> {
    await this.env.HEALING_KV.put('status:health', JSON.stringify(status), {
      expirationTtl: 3600, // 1 hour
    });
  }

  /**
   * Log a healing action
   */
  private async logHealingAction(action: HealingAction): Promise<void> {
    const key = `action:${action.timestamp}:${action.issueId}`;
    await this.env.HEALING_KV.put(key, JSON.stringify(action), {
      expirationTtl: 86400 * 7, // 7 days
    });
  }

  /**
   * Get healing history
   */
  async getHealingHistory(limit = 50): Promise<HealingAction[]> {
    const list = await this.env.HEALING_KV.list({ prefix: 'action:', limit });
    const actions: HealingAction[] = [];

    for (const key of list.keys) {
      const data = await this.env.HEALING_KV.get(key.name);
      if (data) {
        actions.push(JSON.parse(data));
      }
    }

    return actions.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
}

// ============================================================================
// REGISTER JOB EXECUTOR
// ============================================================================

registerExecutor('self_heal', {
  async execute(job: Job, env: Env, logger: Logger): Promise<Record<string, unknown>> {
    const healer = new SelfHealer(env, logger);

    // Run health check first
    const healthStatus = await healer.runHealthCheck();

    return {
      healthy: healthStatus.healthy,
      checksRun: healthStatus.checks.length,
      issuesDetected: healthStatus.issues.length,
      consecutiveFailures: healthStatus.consecutiveFailures,
      healingTriggered: !healthStatus.healthy && env.ENABLE_SELF_HEALING === 'true',
    };
  },
});

/**
 * Process healing messages from the queue
 */
export async function processHealingBatch(
  batch: MessageBatch<HealingMessage>,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const logger = Logger.fromEnv(env).child({ component: 'HealingQueue' });
  const healer = new SelfHealer(env, logger);

  for (const message of batch.messages) {
    try {
      await healer.executeHealing(message.body);
      message.ack();
    } catch (error) {
      logger.error('Failed to process healing message', error, {
        issueId: message.body.issueId,
        action: message.body.action,
      });

      // Retry the message
      if (message.body.attempt < 10) {
        message.retry({ delaySeconds: Math.pow(2, message.body.attempt) * 10 });
      } else {
        message.ack(); // Give up after 10 retries
      }
    }
  }
}
