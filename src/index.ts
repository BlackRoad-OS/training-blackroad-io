/**
 * ⬛⬜🛣️ BlackRoad OS - Cloudflare Workers
 * Agent Jobs, Auto-Updates & Self-Resolution System
 *
 * Main entry point for the Worker
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { z } from 'zod';

import type { Env, JobType, JobPriority, GitHubWebhookPayload, SyncMessage } from './types';
import { Logger, createLogger } from './lib/logger';
import { successResponse, errorResponse, jsonResponse, generateId } from './lib/utils';
import { JobScheduler, getScheduledJobs } from './jobs/scheduler';
import { processJobBatch } from './jobs/executor';
import { RepoScraper } from './sync/repo-scraper';
import { CohesionAnalyzer } from './sync/cohesion-analyzer';
import { AutoUpdater } from './updates/auto-updater';
import { SelfHealer, processHealingBatch } from './healing/self-healer';

// Re-export Durable Objects
export { AgentCoordinator } from './agents/coordinator';
export { RepoSyncAgent } from './agents/repo-sync-agent';
export { SelfHealer as SelfHealerDO } from './agents/self-healer-do';

// ============================================================================
// HONO APP SETUP
// ============================================================================

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors({
  origin: ['https://blackroad.io', 'https://*.blackroad.io', 'http://localhost:*'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  credentials: true,
}));
app.use('*', honoLogger());
app.use('*', prettyJSON());

// Request ID middleware
app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-Id') || generateId('req');
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    name: 'BlackRoad Workers',
    version: '1.0.0',
    status: 'operational',
    emoji: '⬛⬜🛣️',
    endpoints: {
      health: '/api/health',
      jobs: '/api/jobs',
      repos: '/api/repos',
      cohesion: '/api/cohesion',
      updates: '/api/updates',
      healing: '/api/healing',
      webhooks: '/webhooks/github',
    },
  });
});

// ============================================================================
// HEALTH API
// ============================================================================

app.get('/api/health', async (c) => {
  const logger = createLogger(c.env);
  const healer = new SelfHealer(c.env, logger);
  const status = await healer.getHealthStatus();

  return c.json(successResponse({
    status: status?.healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    details: status,
  }));
});

app.post('/api/health/check', async (c) => {
  const logger = createLogger(c.env);
  const healer = new SelfHealer(c.env, logger);
  const status = await healer.runHealthCheck();

  return c.json(successResponse({
    checked: true,
    status,
  }));
});

// ============================================================================
// JOBS API
// ============================================================================

app.get('/api/jobs', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const status = c.req.query('status') as string | undefined;
  const type = c.req.query('type') as string | undefined;
  const limit = parseInt(c.req.query('limit') || '50', 10);

  const { jobs, cursor } = await scheduler.listJobs({
    status: status as any,
    type: type as any,
    limit,
  });

  return c.json(successResponse({ jobs, cursor }));
});

app.get('/api/jobs/stats', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);
  const stats = await scheduler.getStats();

  return c.json(successResponse(stats));
});

app.get('/api/jobs/:id', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);
  const job = await scheduler.getJob(c.req.param('id'));

  if (!job) {
    return jsonResponse(errorResponse('NOT_FOUND', 'Job not found'), 404);
  }

  return c.json(successResponse(job));
});

const createJobSchema = z.object({
  type: z.enum(['repo_sync', 'cohesion_check', 'auto_update', 'self_heal', 'deep_analysis', 'artifact_cleanup', 'health_check', 'webhook_process']),
  payload: z.record(z.unknown()).optional(),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
});

app.post('/api/jobs', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const body = await c.req.json();
  const parsed = createJobSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(errorResponse('INVALID_REQUEST', 'Invalid job parameters', {
      errors: parsed.error.errors,
    }), 400);
  }

  const job = await scheduler.createJob(
    parsed.data.type,
    parsed.data.payload || {},
    {
      priority: parsed.data.priority,
      metadata: { triggeredBy: 'manual' },
    }
  );

  return c.json(successResponse(job), 201);
});

app.post('/api/jobs/:id/cancel', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const job = await scheduler.cancelJob(c.req.param('id'), 'Cancelled via API');

  if (!job) {
    return jsonResponse(errorResponse('NOT_FOUND', 'Job not found'), 404);
  }

  return c.json(successResponse(job));
});

app.post('/api/jobs/:id/retry', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const job = await scheduler.retryJob(c.req.param('id'));

  if (!job) {
    return jsonResponse(errorResponse('RETRY_FAILED', 'Could not retry job'), 400);
  }

  return c.json(successResponse(job));
});

app.post('/api/jobs/trigger-all', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  // Trigger all core jobs
  const jobs = await Promise.all([
    scheduler.createJob('health_check', { quick: false }, { priority: 'high', metadata: { triggeredBy: 'manual' } }),
    scheduler.createJob('repo_sync', { mode: 'full' }, { priority: 'normal', metadata: { triggeredBy: 'manual' } }),
    scheduler.createJob('cohesion_check', { depth: 'standard' }, { priority: 'normal', metadata: { triggeredBy: 'manual' } }),
  ]);

  return c.json(successResponse({ triggered: jobs.length, jobs: jobs.map(j => j.id) }));
});

// ============================================================================
// REPOS API
// ============================================================================

app.get('/api/repos', async (c) => {
  const logger = createLogger(c.env);
  const scraper = new RepoScraper(c.env, logger);

  const repos = await scraper.syncAllRepos('incremental');

  return c.json(successResponse({
    count: repos.length,
    repos: repos.map(r => ({
      name: r.name,
      fullName: r.fullName,
      cohesionScore: r.cohesionScore,
      issuesCount: r.issues.length,
      lastSyncedAt: r.lastSyncedAt,
    })),
  }));
});

app.get('/api/repos/:owner/:name', async (c) => {
  const logger = createLogger(c.env);
  const scraper = new RepoScraper(c.env, logger);

  const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
  const repo = await scraper.syncRepo(fullName);

  if (!repo) {
    return jsonResponse(errorResponse('NOT_FOUND', 'Repository not found'), 404);
  }

  return c.json(successResponse(repo));
});

app.post('/api/repos/:owner/:name/sync', async (c) => {
  const logger = createLogger(c.env);
  const scraper = new RepoScraper(c.env, logger);

  const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
  const repo = await scraper.syncRepo(fullName, true);

  if (!repo) {
    return jsonResponse(errorResponse('SYNC_FAILED', 'Failed to sync repository'), 500);
  }

  return c.json(successResponse(repo));
});

// ============================================================================
// COHESION API
// ============================================================================

app.get('/api/cohesion', async (c) => {
  const logger = createLogger(c.env);
  const analyzer = new CohesionAnalyzer(c.env, logger);

  const report = await analyzer.getLatestReport();

  if (!report) {
    return c.json(successResponse({
      message: 'No cohesion report available. Trigger an analysis first.',
      triggerUrl: '/api/cohesion/analyze',
    }));
  }

  return c.json(successResponse(report));
});

app.post('/api/cohesion/analyze', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const body = await c.req.json().catch(() => ({}));
  const depth = (body as { depth?: string }).depth || 'standard';

  const job = await scheduler.createJob('cohesion_check', { depth }, {
    priority: 'high',
    metadata: { triggeredBy: 'manual' },
  });

  return c.json(successResponse({
    message: 'Cohesion analysis queued',
    jobId: job.id,
  }), 202);
});

// ============================================================================
// UPDATES API
// ============================================================================

app.get('/api/updates', async (c) => {
  const logger = createLogger(c.env);
  const updater = new AutoUpdater(c.env, logger);

  const status = c.req.query('status') as string | undefined;
  const updates = await updater.listPendingUpdates(status as any);

  return c.json(successResponse({
    count: updates.length,
    updates,
  }));
});

app.get('/api/updates/config', async (c) => {
  const logger = createLogger(c.env);
  const updater = new AutoUpdater(c.env, logger);
  const config = await updater.getConfig();

  return c.json(successResponse(config));
});

app.put('/api/updates/config', async (c) => {
  const logger = createLogger(c.env);
  const updater = new AutoUpdater(c.env, logger);

  const body = await c.req.json();
  const config = await updater.setConfig(body);

  return c.json(successResponse(config));
});

app.post('/api/updates/check', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const job = await scheduler.createJob('auto_update', {}, {
    priority: 'normal',
    metadata: { triggeredBy: 'manual' },
  });

  return c.json(successResponse({
    message: 'Update check queued',
    jobId: job.id,
  }), 202);
});

app.post('/api/updates/:id/apply', async (c) => {
  const logger = createLogger(c.env);
  const updater = new AutoUpdater(c.env, logger);

  const result = await updater.applyUpdate(c.req.param('id'));

  if (!result.success) {
    return jsonResponse(errorResponse('APPLY_FAILED', result.error || 'Failed to apply update'), 400);
  }

  return c.json(successResponse({
    applied: true,
    prUrl: result.prUrl,
  }));
});

// ============================================================================
// HEALING API
// ============================================================================

app.get('/api/healing', async (c) => {
  const logger = createLogger(c.env);
  const healer = new SelfHealer(c.env, logger);

  const [status, history] = await Promise.all([
    healer.getHealthStatus(),
    healer.getHealingHistory(20),
  ]);

  return c.json(successResponse({
    status,
    recentActions: history,
  }));
});

app.post('/api/healing/trigger', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  const job = await scheduler.createJob('self_heal', {}, {
    priority: 'high',
    metadata: { triggeredBy: 'manual' },
  });

  return c.json(successResponse({
    message: 'Self-healing triggered',
    jobId: job.id,
  }), 202);
});

// ============================================================================
// AGENTS API
// ============================================================================

app.get('/api/agents', async (c) => {
  const id = c.env.AGENT_COORDINATOR.idFromName('main');
  const stub = c.env.AGENT_COORDINATOR.get(id);

  const response = await stub.fetch(new Request('http://internal/agents'));
  return new Response(response.body, response);
});

app.get('/api/agents/status', async (c) => {
  const id = c.env.AGENT_COORDINATOR.idFromName('main');
  const stub = c.env.AGENT_COORDINATOR.get(id);

  const response = await stub.fetch(new Request('http://internal/status'));
  return new Response(response.body, response);
});

// ============================================================================
// WEBHOOKS
// ============================================================================

app.post('/webhooks/github', async (c) => {
  const logger = createLogger(c.env);
  const scheduler = new JobScheduler(c.env, logger);

  // Verify webhook signature if secret is configured
  if (c.env.WEBHOOK_SECRET) {
    const signature = c.req.header('X-Hub-Signature-256');
    if (!signature) {
      return jsonResponse(errorResponse('UNAUTHORIZED', 'Missing signature'), 401);
    }

    // Verify signature (simplified - in production use crypto.subtle)
    // TODO: Implement proper HMAC verification
  }

  const event = c.req.header('X-GitHub-Event');
  const payload = await c.req.json() as GitHubWebhookPayload;

  logger.info('Received GitHub webhook', { event, repo: payload.repository?.full_name });

  // Queue webhook processing job
  const job = await scheduler.createJob('webhook_process', {
    event,
    payload,
  }, {
    priority: event === 'push' ? 'high' : 'normal',
    metadata: { triggeredBy: 'webhook' },
  });

  return c.json(successResponse({
    received: true,
    event,
    jobId: job.id,
  }), 202);
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.onError((err, c) => {
  const logger = createLogger(c.env);
  logger.error('Unhandled error', err);

  return jsonResponse(errorResponse('INTERNAL_ERROR', err.message), 500);
});

app.notFound((c) => {
  return jsonResponse(errorResponse('NOT_FOUND', 'Endpoint not found'), 404);
});

// ============================================================================
// WORKER EXPORT
// ============================================================================

export default {
  // HTTP request handler
  fetch: app.fetch,

  // Scheduled (cron) handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = Logger.fromEnv(env).child({ component: 'Scheduled' });
    const scheduler = new JobScheduler(env, logger);

    logger.info('Cron triggered', { cron: event.cron });

    // Get jobs for this cron pattern
    const jobs = getScheduledJobs(event.cron);

    for (const { type, payload } of jobs) {
      await scheduler.createJob(type, payload, {
        priority: type === 'health_check' ? 'high' : 'normal',
        metadata: { triggeredBy: 'cron' },
      });
    }

    logger.info('Scheduled jobs created', { count: jobs.length });
  },

  // Queue handlers
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const queueName = batch.queue;

    if (queueName === 'blackroad-job-queue') {
      await processJobBatch(batch as MessageBatch<any>, env, ctx);
    } else if (queueName === 'blackroad-healing-queue') {
      await processHealingBatch(batch as MessageBatch<any>, env, ctx);
    } else if (queueName === 'blackroad-sync-queue') {
      // Process sync queue
      const logger = Logger.fromEnv(env).child({ component: 'SyncQueue' });
      const scraper = new RepoScraper(env, logger);

      for (const message of batch.messages) {
        const syncMessage = message.body as SyncMessage;

        try {
          if (syncMessage.repoName === '*') {
            await scraper.syncAllRepos(syncMessage.action === 'full_sync' ? 'full' : 'incremental');
          } else {
            await scraper.syncRepo(syncMessage.repoName, syncMessage.force);
          }
          message.ack();
        } catch (error) {
          logger.error('Sync failed', error, { repo: syncMessage.repoName });
          message.retry();
        }
      }
    } else if (queueName === 'blackroad-dlq') {
      // Dead letter queue - log and alert
      const logger = Logger.fromEnv(env).child({ component: 'DLQ' });

      for (const message of batch.messages) {
        logger.error('Message in DLQ', undefined, { message: message.body });

        // Send alert if configured
        if (env.ALERT_WEBHOOK_URL) {
          await fetch(env.ALERT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `🚨 Message in Dead Letter Queue: ${JSON.stringify(message.body)}`,
            }),
          });
        }

        message.ack();
      }
    }
  },
};
