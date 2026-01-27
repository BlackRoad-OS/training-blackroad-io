/**
 * ⬛⬜🛣️ BlackRoad OS - Agent Job Scheduler
 * Manages job queuing, execution, and lifecycle
 */

import type { Env, Job, JobType, JobStatus, JobPriority, JobMessage, JobMetadata } from '../types';
import { generateId } from '../lib/utils';
import { Logger } from '../lib/logger';

export class JobScheduler {
  private env: Env;
  private logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger.child({ component: 'JobScheduler' });
  }

  /**
   * Create and queue a new job
   */
  async createJob(
    type: JobType,
    payload: Record<string, unknown>,
    options: {
      priority?: JobPriority;
      metadata?: Partial<JobMetadata>;
      maxRetries?: number;
      delaySeconds?: number;
    } = {}
  ): Promise<Job> {
    const {
      priority = 'normal',
      metadata = {},
      maxRetries = 3,
      delaySeconds = 0,
    } = options;

    const job: Job = {
      id: generateId('job'),
      type,
      status: 'pending',
      priority,
      payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries,
      metadata: {
        triggeredBy: metadata.triggeredBy || 'manual',
        correlationId: metadata.correlationId || generateId('corr'),
        parentJobId: metadata.parentJobId,
        tags: metadata.tags || [],
      },
    };

    // Store job in KV
    await this.env.JOBS_KV.put(`job:${job.id}`, JSON.stringify(job), {
      expirationTtl: 86400 * 7, // 7 days
    });

    // Add to job index
    await this.addToIndex(job);

    // Queue the job message
    const message: JobMessage = {
      jobId: job.id,
      type: job.type,
      payload: job.payload,
      priority: job.priority,
      attempt: 1,
    };

    await this.env.JOB_QUEUE.send(message, {
      delaySeconds,
    });

    this.logger.info('Job created and queued', {
      jobId: job.id,
      type: job.type,
      priority: job.priority,
    });

    return job;
  }

  /**
   * Get a job by ID
   */
  async getJob(jobId: string): Promise<Job | null> {
    const data = await this.env.JOBS_KV.get(`job:${jobId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    extra?: Partial<Job>
  ): Promise<Job | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;

    const updated: Job = {
      ...job,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
    };

    if (status === 'running' && !updated.startedAt) {
      updated.startedAt = new Date().toISOString();
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updated.completedAt = new Date().toISOString();
    }

    await this.env.JOBS_KV.put(`job:${jobId}`, JSON.stringify(updated), {
      expirationTtl: 86400 * 7,
    });

    // Update index
    await this.updateIndex(updated);

    this.logger.info('Job status updated', {
      jobId,
      oldStatus: job.status,
      newStatus: status,
    });

    return updated;
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<Job | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;

    if (job.retryCount >= job.maxRetries) {
      this.logger.warn('Job max retries exceeded', { jobId, retryCount: job.retryCount });
      return null;
    }

    const updated = await this.updateJobStatus(jobId, 'retrying', {
      retryCount: job.retryCount + 1,
      error: undefined,
    });

    if (updated) {
      // Re-queue with exponential backoff
      const delaySeconds = Math.pow(2, updated.retryCount) * 5;

      await this.env.JOB_QUEUE.send({
        jobId: updated.id,
        type: updated.type,
        payload: updated.payload,
        priority: updated.priority,
        attempt: updated.retryCount + 1,
      }, { delaySeconds });

      this.logger.info('Job queued for retry', {
        jobId,
        attempt: updated.retryCount + 1,
        delaySeconds,
      });
    }

    return updated;
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string, reason?: string): Promise<Job | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;

    if (job.status === 'completed' || job.status === 'cancelled') {
      return job;
    }

    return this.updateJobStatus(jobId, 'cancelled', {
      error: reason || 'Job cancelled by user',
    });
  }

  /**
   * List jobs with optional filters
   */
  async listJobs(filters: {
    status?: JobStatus;
    type?: JobType;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ jobs: Job[]; cursor?: string }> {
    const { status, type, limit = 50, cursor } = filters;

    const prefix = status ? `index:status:${status}` : 'index:all';
    const list = await this.env.JOBS_KV.list({ prefix, limit, cursor });

    const jobs: Job[] = [];
    for (const key of list.keys) {
      const jobId = key.name.split(':').pop();
      if (jobId) {
        const job = await this.getJob(jobId);
        if (job && (!type || job.type === type)) {
          jobs.push(job);
        }
      }
    }

    return {
      jobs: jobs.sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }),
      cursor: list.list_complete ? undefined : list.cursor,
    };
  }

  /**
   * Get job statistics
   */
  async getStats(): Promise<{
    total: number;
    byStatus: Record<JobStatus, number>;
    byType: Record<JobType, number>;
    recentFailures: Job[];
  }> {
    const statuses: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'retrying'];
    const types: JobType[] = ['repo_sync', 'cohesion_check', 'auto_update', 'self_heal', 'deep_analysis', 'artifact_cleanup', 'health_check', 'webhook_process'];

    const byStatus: Record<JobStatus, number> = {} as Record<JobStatus, number>;
    const byType: Record<JobType, number> = {} as Record<JobType, number>;
    let total = 0;

    for (const status of statuses) {
      const list = await this.env.JOBS_KV.list({ prefix: `index:status:${status}` });
      byStatus[status] = list.keys.length;
      total += list.keys.length;
    }

    for (const type of types) {
      const list = await this.env.JOBS_KV.list({ prefix: `index:type:${type}` });
      byType[type] = list.keys.length;
    }

    const { jobs: recentFailures } = await this.listJobs({ status: 'failed', limit: 10 });

    return { total, byStatus, byType, recentFailures };
  }

  /**
   * Add job to index for querying
   */
  private async addToIndex(job: Job): Promise<void> {
    const indexKeys = [
      `index:all:${job.id}`,
      `index:status:${job.status}:${job.id}`,
      `index:type:${job.type}:${job.id}`,
      `index:priority:${job.priority}:${job.id}`,
    ];

    await Promise.all(
      indexKeys.map(key =>
        this.env.JOBS_KV.put(key, job.id, { expirationTtl: 86400 * 7 })
      )
    );
  }

  /**
   * Update job in index
   */
  private async updateIndex(job: Job): Promise<void> {
    // Remove old status index entries
    const statuses: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'retrying'];
    for (const status of statuses) {
      if (status !== job.status) {
        await this.env.JOBS_KV.delete(`index:status:${status}:${job.id}`);
      }
    }

    // Add current status index
    await this.env.JOBS_KV.put(`index:status:${job.status}:${job.id}`, job.id, {
      expirationTtl: 86400 * 7,
    });
  }

  /**
   * Clean up old jobs
   */
  async cleanup(maxAgeDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    let cleaned = 0;

    const completedStatuses: JobStatus[] = ['completed', 'failed', 'cancelled'];

    for (const status of completedStatuses) {
      const { jobs } = await this.listJobs({ status, limit: 100 });

      for (const job of jobs) {
        if (job.completedAt && job.completedAt < cutoff) {
          await this.deleteJob(job.id);
          cleaned++;
        }
      }
    }

    this.logger.info('Job cleanup completed', { cleaned, maxAgeDays });
    return cleaned;
  }

  /**
   * Delete a job
   */
  private async deleteJob(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) return;

    const keysToDelete = [
      `job:${jobId}`,
      `index:all:${jobId}`,
      `index:status:${job.status}:${jobId}`,
      `index:type:${job.type}:${jobId}`,
      `index:priority:${job.priority}:${jobId}`,
    ];

    await Promise.all(keysToDelete.map(key => this.env.JOBS_KV.delete(key)));
  }
}

/**
 * Create default jobs based on cron schedule
 */
export function getScheduledJobs(cronPattern: string): Array<{ type: JobType; payload: Record<string, unknown> }> {
  const jobs: Array<{ type: JobType; payload: Record<string, unknown> }> = [];

  switch (cronPattern) {
    case '*/5 * * * *': // Every 5 minutes
      jobs.push({ type: 'health_check', payload: { quick: true } });
      break;

    case '*/15 * * * *': // Every 15 minutes
      jobs.push({ type: 'repo_sync', payload: { mode: 'incremental' } });
      break;

    case '0 * * * *': // Every hour
      jobs.push({ type: 'cohesion_check', payload: { depth: 'standard' } });
      break;

    case '0 0 * * *': // Daily at midnight
      jobs.push({ type: 'deep_analysis', payload: { full: true } });
      jobs.push({ type: 'artifact_cleanup', payload: { maxAgeDays: 7 } });
      break;

    case '0 0 * * 0': // Weekly on Sunday
      jobs.push({ type: 'cohesion_check', payload: { depth: 'comprehensive', generateReport: true } });
      break;
  }

  return jobs;
}
