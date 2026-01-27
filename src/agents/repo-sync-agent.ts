/**
 * ⬛⬜🛣️ BlackRoad OS - Repository Sync Agent Durable Object
 * Maintains persistent state for repository synchronization
 */

import type { Env, RepoInfo, SyncMessage } from '../types';

interface SyncState {
  repos: Map<string, RepoInfo>;
  syncQueue: string[];
  lastFullSync: string | null;
  consecutiveSyncFailures: number;
  initialized: boolean;
}

export class RepoSyncAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private syncState: SyncState = {
    repos: new Map(),
    syncQueue: [],
    lastFullSync: null,
    consecutiveSyncFailures: 0,
    initialized: false,
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      await this.loadState();
    });
  }

  private async loadState(): Promise<void> {
    const stored = await this.state.storage.get<string>('sync_state');
    if (stored) {
      const parsed = JSON.parse(stored);
      this.syncState = {
        repos: new Map(Object.entries(parsed.repos || {})),
        syncQueue: parsed.syncQueue || [],
        lastFullSync: parsed.lastFullSync || null,
        consecutiveSyncFailures: parsed.consecutiveSyncFailures || 0,
        initialized: true,
      };
    } else {
      this.syncState.initialized = true;
      await this.saveState();
    }
  }

  private async saveState(): Promise<void> {
    const serializable = {
      repos: Object.fromEntries(this.syncState.repos),
      syncQueue: this.syncState.syncQueue,
      lastFullSync: this.syncState.lastFullSync,
      consecutiveSyncFailures: this.syncState.consecutiveSyncFailures,
    };
    await this.state.storage.put('sync_state', JSON.stringify(serializable));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/status') {
        return this.getStatus();
      }

      if (request.method === 'GET' && path === '/repos') {
        return this.listRepos();
      }

      if (request.method === 'GET' && path.startsWith('/repo/')) {
        const repoName = path.substring(6);
        return this.getRepo(repoName);
      }

      if (request.method === 'POST' && path === '/sync') {
        const body = await request.json() as SyncMessage;
        return this.queueSync(body);
      }

      if (request.method === 'POST' && path === '/update') {
        const body = await request.json() as { repo: RepoInfo };
        return this.updateRepo(body.repo);
      }

      if (request.method === 'POST' && path === '/complete') {
        const body = await request.json() as { success: boolean; reposUpdated: number };
        return this.completeSyncCycle(body.success, body.reposUpdated);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private getStatus(): Response {
    const repos = Array.from(this.syncState.repos.values());
    const avgCohesion = repos.length > 0
      ? repos.reduce((acc, r) => acc + (r.cohesionScore || 0), 0) / repos.length
      : 0;

    return new Response(JSON.stringify({
      initialized: this.syncState.initialized,
      reposTracked: repos.length,
      syncQueueLength: this.syncState.syncQueue.length,
      lastFullSync: this.syncState.lastFullSync,
      consecutiveFailures: this.syncState.consecutiveSyncFailures,
      averageCohesion: avgCohesion,
      healthStatus: this.syncState.consecutiveSyncFailures < 3 ? 'healthy' : 'degraded',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private listRepos(): Response {
    const repos = Array.from(this.syncState.repos.values());
    return new Response(JSON.stringify({
      repos: repos.map(r => ({
        name: r.name,
        fullName: r.fullName,
        lastSyncedAt: r.lastSyncedAt,
        cohesionScore: r.cohesionScore,
        issuesCount: r.issues.length,
      })),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getRepo(repoName: string): Response {
    const repo = this.syncState.repos.get(repoName);
    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repo not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ repo }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async queueSync(message: SyncMessage): Promise<Response> {
    if (!this.syncState.syncQueue.includes(message.repoName)) {
      this.syncState.syncQueue.push(message.repoName);
      await this.saveState();
    }

    // Also queue to the external sync queue
    await this.env.SYNC_QUEUE.send(message);

    return new Response(JSON.stringify({
      queued: true,
      queuePosition: this.syncState.syncQueue.indexOf(message.repoName) + 1,
      queueLength: this.syncState.syncQueue.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async updateRepo(repo: RepoInfo): Promise<Response> {
    this.syncState.repos.set(repo.name, repo);

    // Remove from sync queue if present
    const index = this.syncState.syncQueue.indexOf(repo.name);
    if (index >= 0) {
      this.syncState.syncQueue.splice(index, 1);
    }

    await this.saveState();

    return new Response(JSON.stringify({
      updated: true,
      repo: repo.name,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async completeSyncCycle(success: boolean, reposUpdated: number): Promise<Response> {
    if (success) {
      this.syncState.lastFullSync = new Date().toISOString();
      this.syncState.consecutiveSyncFailures = 0;
    } else {
      this.syncState.consecutiveSyncFailures++;
    }

    await this.saveState();

    // Trigger self-healing if too many failures
    if (this.syncState.consecutiveSyncFailures >= 3) {
      await this.env.HEALING_QUEUE.send({
        issueId: `sync_failures_${Date.now()}`,
        action: 'retry_sync',
        context: {
          consecutiveFailures: this.syncState.consecutiveSyncFailures,
          lastAttempt: new Date().toISOString(),
        },
        attempt: 1,
      });
    }

    return new Response(JSON.stringify({
      cycleCompleted: true,
      success,
      reposUpdated,
      consecutiveFailures: this.syncState.consecutiveSyncFailures,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Alarm handler for periodic sync
  async alarm(): Promise<void> {
    // Check if we need a sync
    const lastSync = this.syncState.lastFullSync
      ? new Date(this.syncState.lastFullSync).getTime()
      : 0;

    if (Date.now() - lastSync > 60 * 60 * 1000) { // 1 hour
      // Queue full sync
      await this.env.SYNC_QUEUE.send({
        repoName: '*',
        action: 'full_sync',
      });
    }

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000); // 15 minutes
  }
}
