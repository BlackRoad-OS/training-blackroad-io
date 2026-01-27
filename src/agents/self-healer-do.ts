/**
 * ⬛⬜🛣️ BlackRoad OS - Self-Healer Durable Object
 * Maintains persistent state for self-healing operations
 */

import type { Env, HealthStatus, HealthIssue, HealingAction } from '../types';

interface HealerState {
  currentHealth: HealthStatus | null;
  activeIssues: Map<string, HealthIssue>;
  healingHistory: HealingAction[];
  escalationCount: number;
  lastHealthCheck: string | null;
  initialized: boolean;
}

export class SelfHealer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private healerState: HealerState = {
    currentHealth: null,
    activeIssues: new Map(),
    healingHistory: [],
    escalationCount: 0,
    lastHealthCheck: null,
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
    const stored = await this.state.storage.get<string>('healer_state');
    if (stored) {
      const parsed = JSON.parse(stored);
      this.healerState = {
        currentHealth: parsed.currentHealth || null,
        activeIssues: new Map(Object.entries(parsed.activeIssues || {})),
        healingHistory: parsed.healingHistory || [],
        escalationCount: parsed.escalationCount || 0,
        lastHealthCheck: parsed.lastHealthCheck || null,
        initialized: true,
      };
    } else {
      this.healerState.initialized = true;
      await this.saveState();
    }
  }

  private async saveState(): Promise<void> {
    const serializable = {
      currentHealth: this.healerState.currentHealth,
      activeIssues: Object.fromEntries(this.healerState.activeIssues),
      healingHistory: this.healerState.healingHistory.slice(-100), // Keep last 100
      escalationCount: this.healerState.escalationCount,
      lastHealthCheck: this.healerState.lastHealthCheck,
    };
    await this.state.storage.put('healer_state', JSON.stringify(serializable));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/status') {
        return this.getStatus();
      }

      if (request.method === 'GET' && path === '/issues') {
        return this.listIssues();
      }

      if (request.method === 'GET' && path === '/history') {
        return this.getHistory();
      }

      if (request.method === 'POST' && path === '/health') {
        const body = await request.json() as { health: HealthStatus };
        return this.updateHealth(body.health);
      }

      if (request.method === 'POST' && path === '/issue') {
        const body = await request.json() as { issue: HealthIssue };
        return this.reportIssue(body.issue);
      }

      if (request.method === 'POST' && path === '/resolve') {
        const body = await request.json() as { issueId: string };
        return this.resolveIssue(body.issueId);
      }

      if (request.method === 'POST' && path === '/action') {
        const body = await request.json() as { action: HealingAction };
        return this.recordAction(body.action);
      }

      if (request.method === 'POST' && path === '/reset') {
        return this.resetState();
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
    const activeIssues = Array.from(this.healerState.activeIssues.values());
    const criticalIssues = activeIssues.filter(i => i.severity === 'critical' && !i.resolved);
    const recentActions = this.healerState.healingHistory.slice(-10);
    const successRate = recentActions.length > 0
      ? recentActions.filter(a => a.success).length / recentActions.length
      : 1;

    return new Response(JSON.stringify({
      initialized: this.healerState.initialized,
      healthy: this.healerState.currentHealth?.healthy ?? true,
      activeIssuesCount: activeIssues.filter(i => !i.resolved).length,
      criticalIssuesCount: criticalIssues.length,
      escalationCount: this.healerState.escalationCount,
      healingSuccessRate: successRate,
      lastHealthCheck: this.healerState.lastHealthCheck,
      consecutiveFailures: this.healerState.currentHealth?.consecutiveFailures ?? 0,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private listIssues(): Response {
    const issues = Array.from(this.healerState.activeIssues.values());
    return new Response(JSON.stringify({
      issues: issues.sort((a, b) => {
        // Sort by: unresolved first, then by severity, then by date
        if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        if (a.severity !== b.severity) return severityOrder[a.severity] - severityOrder[b.severity];
        return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
      }),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    return new Response(JSON.stringify({
      history: this.healerState.healingHistory.slice().reverse(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async updateHealth(health: HealthStatus): Promise<Response> {
    this.healerState.currentHealth = health;
    this.healerState.lastHealthCheck = new Date().toISOString();

    // Add any new issues
    for (const issue of health.issues) {
      if (!this.healerState.activeIssues.has(issue.id)) {
        this.healerState.activeIssues.set(issue.id, issue);
      }
    }

    await this.saveState();

    return new Response(JSON.stringify({
      updated: true,
      healthy: health.healthy,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async reportIssue(issue: HealthIssue): Promise<Response> {
    this.healerState.activeIssues.set(issue.id, issue);
    await this.saveState();

    // Queue healing if auto-healable
    if (issue.autoHealable && this.env.ENABLE_SELF_HEALING === 'true') {
      await this.env.HEALING_QUEUE.send({
        issueId: issue.id,
        action: issue.type,
        context: { issue },
        attempt: 1,
      });
    }

    return new Response(JSON.stringify({
      reported: true,
      issueId: issue.id,
      healingQueued: issue.autoHealable,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async resolveIssue(issueId: string): Promise<Response> {
    const issue = this.healerState.activeIssues.get(issueId);
    if (!issue) {
      return new Response(JSON.stringify({ error: 'Issue not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    issue.resolved = true;
    issue.resolvedAt = new Date().toISOString();
    await this.saveState();

    return new Response(JSON.stringify({
      resolved: true,
      issueId,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async recordAction(action: HealingAction): Promise<Response> {
    this.healerState.healingHistory.push(action);

    // Track escalations
    if (action.type === 'escalate') {
      this.healerState.escalationCount++;
    }

    // Update related issue
    const issue = this.healerState.activeIssues.get(action.issueId);
    if (issue) {
      issue.healingAttempts++;
      issue.lastAttempt = action.timestamp;
      if (action.success) {
        issue.resolved = true;
        issue.resolvedAt = action.timestamp;
      }
    }

    await this.saveState();

    return new Response(JSON.stringify({
      recorded: true,
      success: action.success,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async resetState(): Promise<Response> {
    // Clear resolved issues
    for (const [id, issue] of this.healerState.activeIssues) {
      if (issue.resolved) {
        this.healerState.activeIssues.delete(id);
      }
    }

    // Reset counters
    this.healerState.escalationCount = 0;

    await this.saveState();

    return new Response(JSON.stringify({
      reset: true,
      remainingIssues: this.healerState.activeIssues.size,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Alarm handler for periodic health checks
  async alarm(): Promise<void> {
    // Check how long since last health check
    const lastCheck = this.healerState.lastHealthCheck
      ? new Date(this.healerState.lastHealthCheck).getTime()
      : 0;

    if (Date.now() - lastCheck > 5 * 60 * 1000) { // 5 minutes
      // Trigger health check job
      await this.env.JOB_QUEUE.send({
        jobId: `health_${Date.now()}`,
        type: 'health_check',
        payload: { quick: true },
        priority: 'normal',
        attempt: 1,
      });
    }

    // Check for stale unresolved issues
    for (const [id, issue] of this.healerState.activeIssues) {
      if (!issue.resolved && issue.autoHealable) {
        const detectedAt = new Date(issue.detectedAt).getTime();
        if (Date.now() - detectedAt > 30 * 60 * 1000) { // 30 minutes
          // Escalate stale issues
          await this.env.HEALING_QUEUE.send({
            issueId: id,
            action: 'escalate',
            context: {
              issue,
              reason: 'Stale unresolved issue',
            },
            attempt: 1,
          });
        }
      }
    }

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000); // 5 minutes
  }
}
