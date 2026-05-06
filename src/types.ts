export interface EnvConfig {
  name: string;
  url: string; // Airflow base URL, e.g. https://xxx.composer.cloud.google.com
}

export interface Settings {
  envs: EnvConfig[];
  oauthClientId: string; // GCP OAuth2 client_id for launchWebAuthFlow
  manualToken: string;
  manualTokenExpiry: string; // ISO date string
  useManualToken: boolean;
}

export type TaskState =
  | 'success'
  | 'failed'
  | 'running'
  | 'queued'
  | 'up_for_retry'
  | 'skipped'
  | 'upstream_failed'
  | 'deferred'
  | 'removed'
  | null;

export interface AirflowTask {
  task_id: string;
  operator: string;        // full class name
  downstream_task_ids: string[];
  state?: TaskState;       // populated from the last dag run's task instances
  duration_seconds?: number;
}

export interface DagMeta {
  dag_id: string;
  schedule_interval: string | null;
  is_paused: boolean;
  last_run_id: string | null;
  last_run_state: string | null;
  last_run_start: string | null;
  last_success_run_id: string | null;
}

export interface DagRun {
  run_id:         string;
  state:          string;
  execution_date: string;
  start_date:     string | null;
}

export interface TaskSqlResult {
  sql: string | null;
  source: 'rendered' | 'raw' | 'none';
}

// ── ReactFlow node data ────────────────────────────────────────────────────────

export interface TaskNodeData extends Record<string, unknown> {
  taskId: string;
  operatorFull: string;
  operatorShort: string;
  state: TaskState;
  durationSeconds?: number;
}
