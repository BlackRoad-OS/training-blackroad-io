/**
 * ⬛⬜🛣️ BlackRoad OS - Type Definitions
 * Agent Jobs, Auto-Updates & Self-Resolution System
 */

// ============================================================================
// ENVIRONMENT BINDINGS
// ============================================================================

export interface Env {
  // KV Namespaces
  JOBS_KV: KVNamespace;
  REPOS_KV: KVNamespace;
  HEALING_KV: KVNamespace;
  AGENT_MEMORY_KV: KVNamespace;

  // Durable Objects
  AGENT_COORDINATOR: DurableObjectNamespace;
  REPO_SYNC_AGENT: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;

  // Queues
  JOB_QUEUE: Queue<JobMessage>;
  SYNC_QUEUE: Queue<SyncMessage>;
  HEALING_QUEUE: Queue<HealingMessage>;

  // R2 Storage
  ARTIFACTS_BUCKET: R2Bucket;

  // Environment Variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  BLACKROAD_ORG: string;
  ENABLE_SELF_HEALING: string;
  ENABLE_AUTO_UPDATES: string;
  COHESION_THRESHOLD: string;
  MONITORED_REPOS: string;

  // Secrets
  GITHUB_TOKEN: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  WEBHOOK_SECRET?: string;
  ALERT_WEBHOOK_URL?: string;
}

// ============================================================================
// JOB SYSTEM TYPES
// ============================================================================

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';
export type JobType =
  | 'repo_sync'
  | 'cohesion_check'
  | 'auto_update'
  | 'self_heal'
  | 'deep_analysis'
  | 'artifact_cleanup'
  | 'health_check'
  | 'webhook_process';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: JobPriority;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  maxRetries: number;
  error?: string;
  result?: Record<string, unknown>;
  metadata: JobMetadata;
}

export interface JobMetadata {
  triggeredBy: 'cron' | 'webhook' | 'manual' | 'auto_heal' | 'cascade';
  correlationId?: string;
  parentJobId?: string;
  tags: string[];
}

export interface JobMessage {
  jobId: string;
  type: JobType;
  payload: Record<string, unknown>;
  priority: JobPriority;
  attempt: number;
}

// ============================================================================
// REPO SYNC TYPES
// ============================================================================

export interface RepoInfo {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  lastSyncedAt?: string;
  lastCommitSha?: string;
  structure?: RepoStructure;
  cohesionScore?: number;
  issues: RepoIssue[];
}

export interface RepoStructure {
  directories: string[];
  files: FileInfo[];
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  workflows: string[];
  config: Record<string, unknown>;
}

export interface FileInfo {
  path: string;
  size: number;
  sha: string;
  lastModified?: string;
  type: 'source' | 'config' | 'docs' | 'test' | 'workflow' | 'other';
}

export interface RepoIssue {
  type: 'missing_file' | 'outdated_dependency' | 'inconsistent_config' | 'broken_workflow' | 'cohesion_gap';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  path?: string;
  suggestion?: string;
  autoFixable: boolean;
}

export interface SyncMessage {
  repoName: string;
  action: 'full_sync' | 'incremental' | 'structure_only' | 'cohesion_check';
  force?: boolean;
}

export interface CohesionReport {
  timestamp: string;
  overallScore: number;
  repos: RepoInfo[];
  crossRepoIssues: CrossRepoIssue[];
  recommendations: Recommendation[];
}

export interface CrossRepoIssue {
  type: 'version_mismatch' | 'missing_shared_config' | 'inconsistent_naming' | 'broken_reference';
  repos: string[];
  description: string;
  impact: 'high' | 'medium' | 'low';
  resolution?: string;
}

export interface Recommendation {
  priority: number;
  action: string;
  reason: string;
  affectedRepos: string[];
  estimatedEffort: 'trivial' | 'small' | 'medium' | 'large';
}

// ============================================================================
// AUTO-UPDATE TYPES
// ============================================================================

export interface UpdateConfig {
  enabled: boolean;
  autoMerge: boolean;
  requireApproval: boolean;
  allowedUpdateTypes: UpdateType[];
  scheduleWindow?: ScheduleWindow;
  excludePatterns: string[];
}

export type UpdateType = 'dependency' | 'workflow' | 'config' | 'documentation' | 'code';

export interface ScheduleWindow {
  startHour: number;
  endHour: number;
  daysOfWeek: number[];
  timezone: string;
}

export interface PendingUpdate {
  id: string;
  type: UpdateType;
  repo: string;
  title: string;
  description: string;
  diff?: string;
  sourceRepo?: string;
  priority: JobPriority;
  createdAt: string;
  status: 'pending' | 'approved' | 'applied' | 'rejected' | 'failed';
}

// ============================================================================
// SELF-HEALING TYPES
// ============================================================================

export interface HealthStatus {
  healthy: boolean;
  timestamp: string;
  checks: HealthCheck[];
  issues: HealthIssue[];
  lastHealingAttempt?: string;
  consecutiveFailures: number;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  latency?: number;
  metadata?: Record<string, unknown>;
}

export interface HealthIssue {
  id: string;
  type: HealingActionType;
  severity: 'critical' | 'warning' | 'info';
  detectedAt: string;
  description: string;
  autoHealable: boolean;
  healingAttempts: number;
  lastAttempt?: string;
  resolved: boolean;
  resolvedAt?: string;
}

export type HealingActionType =
  | 'restart_job'
  | 'clear_cache'
  | 'retry_sync'
  | 'reset_state'
  | 'notify_admin'
  | 'escalate'
  | 'rollback'
  | 'recreate_resource';

export interface HealingMessage {
  issueId: string;
  action: HealingActionType;
  context: Record<string, unknown>;
  attempt: number;
}

export interface HealingAction {
  type: HealingActionType;
  issueId: string;
  timestamp: string;
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  duration: number;
}

// ============================================================================
// AGENT TYPES
// ============================================================================

export interface AgentState {
  id: string;
  name: string;
  status: 'idle' | 'busy' | 'error' | 'maintenance';
  currentJob?: string;
  lastActivity: string;
  stats: AgentStats;
  memory: AgentMemory;
}

export interface AgentStats {
  jobsCompleted: number;
  jobsFailed: number;
  totalRuntime: number;
  averageJobDuration: number;
  successRate: number;
}

export interface AgentMemory {
  shortTerm: Record<string, unknown>;
  patterns: LearnedPattern[];
  decisions: Decision[];
}

export interface LearnedPattern {
  id: string;
  type: string;
  pattern: string;
  confidence: number;
  occurrences: number;
  lastSeen: string;
  action?: string;
}

export interface Decision {
  timestamp: string;
  context: string;
  action: string;
  outcome: 'success' | 'failure' | 'partial';
  feedback?: string;
}

// ============================================================================
// API TYPES
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiMeta {
  requestId: string;
  timestamp: string;
  duration?: number;
}

// ============================================================================
// WEBHOOK TYPES
// ============================================================================

export interface GitHubWebhookPayload {
  action?: string;
  repository?: {
    full_name: string;
    name: string;
    default_branch: string;
  };
  sender?: {
    login: string;
    type: string;
  };
  commits?: Array<{
    id: string;
    message: string;
    author: { name: string; email: string };
    modified: string[];
    added: string[];
    removed: string[];
  }>;
  pull_request?: {
    number: number;
    title: string;
    state: string;
    merged: boolean;
  };
  ref?: string;
  before?: string;
  after?: string;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  error?: Error;
}
