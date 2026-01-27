/**
 * ⬛⬜🛣️ BlackRoad OS - Agent Coordinator Durable Object
 * Manages agent state and orchestrates tasks
 */

import type { Env, AgentState, AgentStats, AgentMemory, LearnedPattern, Decision } from '../types';
import { generateId } from '../lib/utils';

interface CoordinatorState {
  agents: Map<string, AgentState>;
  activeJobs: Map<string, string>; // jobId -> agentId
  patterns: LearnedPattern[];
  initialized: boolean;
}

export class AgentCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private coordinatorState: CoordinatorState = {
    agents: new Map(),
    activeJobs: new Map(),
    patterns: [],
    initialized: false,
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Initialize from storage
    this.state.blockConcurrencyWhile(async () => {
      await this.loadState();
    });
  }

  private async loadState(): Promise<void> {
    const stored = await this.state.storage.get<string>('coordinator_state');
    if (stored) {
      const parsed = JSON.parse(stored);
      this.coordinatorState = {
        agents: new Map(Object.entries(parsed.agents || {})),
        activeJobs: new Map(Object.entries(parsed.activeJobs || {})),
        patterns: parsed.patterns || [],
        initialized: true,
      };
    } else {
      // Initialize default agents
      this.coordinatorState.agents = new Map([
        ['sync-agent', this.createAgent('sync-agent', 'Repository Sync Agent')],
        ['cohesion-agent', this.createAgent('cohesion-agent', 'Cohesion Analysis Agent')],
        ['update-agent', this.createAgent('update-agent', 'Auto-Update Agent')],
        ['healing-agent', this.createAgent('healing-agent', 'Self-Healing Agent')],
      ]);
      this.coordinatorState.initialized = true;
      await this.saveState();
    }
  }

  private async saveState(): Promise<void> {
    const serializable = {
      agents: Object.fromEntries(this.coordinatorState.agents),
      activeJobs: Object.fromEntries(this.coordinatorState.activeJobs),
      patterns: this.coordinatorState.patterns,
    };
    await this.state.storage.put('coordinator_state', JSON.stringify(serializable));
  }

  private createAgent(id: string, name: string): AgentState {
    return {
      id,
      name,
      status: 'idle',
      lastActivity: new Date().toISOString(),
      stats: {
        jobsCompleted: 0,
        jobsFailed: 0,
        totalRuntime: 0,
        averageJobDuration: 0,
        successRate: 1,
      },
      memory: {
        shortTerm: {},
        patterns: [],
        decisions: [],
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/status') {
        return this.getStatus();
      }

      if (request.method === 'GET' && path === '/agents') {
        return this.listAgents();
      }

      if (request.method === 'POST' && path === '/assign') {
        const body = await request.json() as { jobId: string; jobType: string };
        return this.assignJob(body.jobId, body.jobType);
      }

      if (request.method === 'POST' && path === '/complete') {
        const body = await request.json() as { jobId: string; success: boolean; duration: number };
        return this.completeJob(body.jobId, body.success, body.duration);
      }

      if (request.method === 'POST' && path === '/learn') {
        const body = await request.json() as { pattern: Omit<LearnedPattern, 'id'> };
        return this.learnPattern(body.pattern);
      }

      if (request.method === 'POST' && path === '/decide') {
        const body = await request.json() as { agentId: string; decision: Omit<Decision, 'timestamp'> };
        return this.recordDecision(body.agentId, body.decision);
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
    const agents = Array.from(this.coordinatorState.agents.values());
    const busyAgents = agents.filter(a => a.status === 'busy').length;
    const activeJobs = this.coordinatorState.activeJobs.size;

    return new Response(JSON.stringify({
      initialized: this.coordinatorState.initialized,
      totalAgents: agents.length,
      busyAgents,
      idleAgents: agents.length - busyAgents,
      activeJobs,
      patternsLearned: this.coordinatorState.patterns.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private listAgents(): Response {
    const agents = Array.from(this.coordinatorState.agents.values());
    return new Response(JSON.stringify({ agents }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async assignJob(jobId: string, jobType: string): Promise<Response> {
    // Find the best agent for this job type
    const agentMapping: Record<string, string> = {
      repo_sync: 'sync-agent',
      cohesion_check: 'cohesion-agent',
      deep_analysis: 'cohesion-agent',
      auto_update: 'update-agent',
      self_heal: 'healing-agent',
      health_check: 'healing-agent',
    };

    const agentId = agentMapping[jobType] || 'sync-agent';
    const agent = this.coordinatorState.agents.get(agentId);

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update agent state
    agent.status = 'busy';
    agent.currentJob = jobId;
    agent.lastActivity = new Date().toISOString();

    // Track active job
    this.coordinatorState.activeJobs.set(jobId, agentId);

    await this.saveState();

    return new Response(JSON.stringify({
      assigned: true,
      agentId,
      agentName: agent.name,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async completeJob(jobId: string, success: boolean, duration: number): Promise<Response> {
    const agentId = this.coordinatorState.activeJobs.get(jobId);
    if (!agentId) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const agent = this.coordinatorState.agents.get(agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update stats
    if (success) {
      agent.stats.jobsCompleted++;
    } else {
      agent.stats.jobsFailed++;
    }
    agent.stats.totalRuntime += duration;
    agent.stats.averageJobDuration = agent.stats.totalRuntime / (agent.stats.jobsCompleted + agent.stats.jobsFailed);
    agent.stats.successRate = agent.stats.jobsCompleted / (agent.stats.jobsCompleted + agent.stats.jobsFailed);

    // Reset agent state
    agent.status = 'idle';
    agent.currentJob = undefined;
    agent.lastActivity = new Date().toISOString();

    // Remove from active jobs
    this.coordinatorState.activeJobs.delete(jobId);

    await this.saveState();

    return new Response(JSON.stringify({
      completed: true,
      agentId,
      stats: agent.stats,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async learnPattern(pattern: Omit<LearnedPattern, 'id'>): Promise<Response> {
    const existingIndex = this.coordinatorState.patterns.findIndex(
      p => p.type === pattern.type && p.pattern === pattern.pattern
    );

    if (existingIndex >= 0) {
      // Update existing pattern
      const existing = this.coordinatorState.patterns[existingIndex];
      existing.occurrences++;
      existing.lastSeen = new Date().toISOString();
      existing.confidence = Math.min(1, existing.confidence + 0.1);
    } else {
      // Add new pattern
      this.coordinatorState.patterns.push({
        id: generateId('pat'),
        ...pattern,
        lastSeen: new Date().toISOString(),
      });
    }

    await this.saveState();

    return new Response(JSON.stringify({
      learned: true,
      totalPatterns: this.coordinatorState.patterns.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async recordDecision(agentId: string, decision: Omit<Decision, 'timestamp'>): Promise<Response> {
    const agent = this.coordinatorState.agents.get(agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    agent.memory.decisions.push({
      ...decision,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 100 decisions
    if (agent.memory.decisions.length > 100) {
      agent.memory.decisions = agent.memory.decisions.slice(-100);
    }

    await this.saveState();

    return new Response(JSON.stringify({
      recorded: true,
      totalDecisions: agent.memory.decisions.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Handle alarms for scheduled cleanup
  async alarm(): Promise<void> {
    // Clean up stale agents
    for (const [agentId, agent] of this.coordinatorState.agents) {
      if (agent.status === 'busy' && agent.currentJob) {
        const lastActivity = new Date(agent.lastActivity).getTime();
        if (Date.now() - lastActivity > 30 * 60 * 1000) { // 30 minutes
          agent.status = 'idle';
          agent.currentJob = undefined;
          this.coordinatorState.activeJobs.delete(agent.currentJob || '');
        }
      }
    }

    await this.saveState();

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000); // 5 minutes
  }
}
