/**
 * ⬛⬜🛣️ BlackRoad OS - Job Executor
 * Processes jobs from the queue
 */

import type { Env, Job, JobMessage, JobType } from '../types';
import { JobScheduler } from './scheduler';
import { Logger } from '../lib/logger';

export interface JobExecutor {
  execute(job: Job, env: Env, logger: Logger): Promise<Record<string, unknown>>;
}

// Registry of job executors
const executors: Map<JobType, JobExecutor> = new Map();

/**
 * Register a job executor
 */
export function registerExecutor(type: JobType, executor: JobExecutor): void {
  executors.set(type, executor);
}

/**
 * Process a batch of job messages from the queue
 */
export async function processJobBatch(
  batch: MessageBatch<JobMessage>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const logger = Logger.fromEnv(env).child({ component: 'JobExecutor' });
  const scheduler = new JobScheduler(env, logger);

  for (const message of batch.messages) {
    const { jobId, type, attempt } = message.body;

    logger.info('Processing job', { jobId, type, attempt });

    try {
      // Get the job from KV
      const job = await scheduler.getJob(jobId);
      if (!job) {
        logger.warn('Job not found, acknowledging message', { jobId });
        message.ack();
        continue;
      }

      // Check if job is still pending/retrying
      if (!['pending', 'retrying'].includes(job.status)) {
        logger.info('Job already processed, skipping', { jobId, status: job.status });
        message.ack();
        continue;
      }

      // Mark as running
      await scheduler.updateJobStatus(jobId, 'running');

      // Get executor for this job type
      const executor = executors.get(type);
      if (!executor) {
        throw new Error(`No executor registered for job type: ${type}`);
      }

      // Execute the job
      const startTime = Date.now();
      const result = await executor.execute(job, env, logger);
      const duration = Date.now() - startTime;

      // Mark as completed
      await scheduler.updateJobStatus(jobId, 'completed', {
        result: { ...result, duration },
      });

      logger.info('Job completed successfully', { jobId, duration });
      message.ack();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Job execution failed', error, { jobId, type, attempt });

      // Update job with error
      const updatedJob = await scheduler.updateJobStatus(jobId, 'failed', {
        error: errorMessage,
      });

      // Attempt retry if under max retries
      if (updatedJob && updatedJob.retryCount < updatedJob.maxRetries) {
        await scheduler.retryJob(jobId);
        message.ack();
      } else {
        // Send to dead letter queue or trigger self-healing
        if (env.ENABLE_SELF_HEALING === 'true') {
          await env.HEALING_QUEUE.send({
            issueId: `job_failure_${jobId}`,
            action: 'restart_job',
            context: {
              jobId,
              type,
              error: errorMessage,
              attempts: attempt,
            },
            attempt: 1,
          });
        }
        message.ack();
      }
    }
  }
}

// ============================================================================
// BUILT-IN JOB EXECUTORS
// ============================================================================

/**
 * Health Check Executor
 */
registerExecutor('health_check', {
  async execute(job, env, logger): Promise<Record<string, unknown>> {
    logger.info('Running health check', { quick: job.payload.quick });

    const checks = [];

    // Check KV access
    try {
      await env.JOBS_KV.put('_health_check', Date.now().toString());
      await env.JOBS_KV.get('_health_check');
      checks.push({ name: 'JOBS_KV', status: 'pass' });
    } catch {
      checks.push({ name: 'JOBS_KV', status: 'fail' });
    }

    // Check queues
    try {
      await env.JOB_QUEUE.send({ jobId: '_health', type: 'health_check', payload: {}, priority: 'low', attempt: 0 });
      checks.push({ name: 'JOB_QUEUE', status: 'pass' });
    } catch {
      checks.push({ name: 'JOB_QUEUE', status: 'fail' });
    }

    const healthy = checks.every(c => c.status === 'pass');

    return {
      healthy,
      checks,
      timestamp: new Date().toISOString(),
    };
  },
});

/**
 * Artifact Cleanup Executor
 */
registerExecutor('artifact_cleanup', {
  async execute(job, env, logger): Promise<Record<string, unknown>> {
    const maxAgeDays = (job.payload.maxAgeDays as number) || 7;
    logger.info('Running artifact cleanup', { maxAgeDays });

    const scheduler = new JobScheduler(env, logger);
    const cleaned = await scheduler.cleanup(maxAgeDays);

    // Clean old R2 objects if bucket is configured
    let artifactsDeleted = 0;
    try {
      const cutoff = new Date(Date.now() - maxAgeDays * 86400000);
      const objects = await env.ARTIFACTS_BUCKET.list({ limit: 100 });

      for (const obj of objects.objects) {
        if (obj.uploaded < cutoff) {
          await env.ARTIFACTS_BUCKET.delete(obj.key);
          artifactsDeleted++;
        }
      }
    } catch (error) {
      logger.warn('R2 cleanup skipped', { error });
    }

    return {
      jobsCleaned: cleaned,
      artifactsDeleted,
      maxAgeDays,
    };
  },
});

/**
 * Webhook Process Executor
 */
registerExecutor('webhook_process', {
  async execute(job, env, logger): Promise<Record<string, unknown>> {
    const { event, payload } = job.payload as { event: string; payload: Record<string, unknown> };
    logger.info('Processing webhook', { event });

    const scheduler = new JobScheduler(env, logger);

    // Handle different webhook events
    switch (event) {
      case 'push':
        // Trigger repo sync for the pushed repo
        await scheduler.createJob('repo_sync', {
          mode: 'incremental',
          repo: (payload.repository as { full_name: string })?.full_name,
          commits: payload.commits,
        }, {
          priority: 'high',
          metadata: { triggeredBy: 'webhook', correlationId: job.metadata.correlationId },
        });
        break;

      case 'pull_request':
        if ((payload.action as string) === 'closed' && (payload.pull_request as { merged: boolean })?.merged) {
          // Trigger cohesion check after PR merge
          await scheduler.createJob('cohesion_check', {
            depth: 'standard',
            repo: (payload.repository as { full_name: string })?.full_name,
          }, {
            priority: 'normal',
            metadata: { triggeredBy: 'webhook', correlationId: job.metadata.correlationId },
          });
        }
        break;

      case 'workflow_run':
        if ((payload.action as string) === 'completed' && (payload.workflow_run as { conclusion: string })?.conclusion === 'failure') {
          // Trigger self-healing for failed workflows
          await env.HEALING_QUEUE.send({
            issueId: `workflow_${(payload.workflow_run as { id: number })?.id}`,
            action: 'notify_admin',
            context: {
              repo: (payload.repository as { full_name: string })?.full_name,
              workflow: (payload.workflow as { name: string })?.name,
              run_id: (payload.workflow_run as { id: number })?.id,
            },
            attempt: 1,
          });
        }
        break;
    }

    return {
      event,
      processed: true,
      actionsTriggered: 1,
    };
  },
});
