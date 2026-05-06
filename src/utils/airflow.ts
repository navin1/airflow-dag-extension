/**
 * Airflow REST API client for Cloud Composer (Airflow 2.x).
 * Mirrors the API call patterns from work_agent/tools/composer_tools.py.
 */

import { getToken, invalidateCachedToken } from './auth';
import {
  extractSql,
  extractRenderedSql,
  bestSql,
  wasRenderedTruncated,
  formatSql,
  isSqlFilePath,
} from './sqlUtils';
import type { AirflowTask, DagMeta, DagRun, TaskSqlResult, TaskState } from '../types';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** URL-encode a single path segment (handles + and : in dag_run_ids). */
function enc(s: string): string {
  return encodeURIComponent(String(s));
}

async function apiFetch(baseUrl: string, path: string, params?: Record<string, string>): Promise<unknown> {
  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    throw new Error(`Auth error: ${(e as Error).message}`);
  }

  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/v1${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.status === 401) {
    await invalidateCachedToken();
    throw new Error('Authentication failed (401). Your token may have expired — re-authenticate in Settings.');
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Airflow API error ${resp.status}: ${body.slice(0, 200) || resp.statusText}`);
  }

  return resp.json();
}

// ── DAG metadata ──────────────────────────────────────────────────────────────

export async function fetchDagMeta(baseUrl: string, dagId: string): Promise<DagMeta> {
  const [dagData, runsData, successRunsData] = await Promise.all([
    apiFetch(baseUrl, `/dags/${enc(dagId)}`),
    apiFetch(baseUrl, `/dags/${enc(dagId)}/dagRuns`, {
      limit: '1', order_by: '-execution_date',
    }),
    apiFetch(baseUrl, `/dags/${enc(dagId)}/dagRuns`, {
      limit: '1', order_by: '-execution_date', state: 'success',
    }),
  ]) as [Record<string, unknown>, Record<string, unknown[]>, Record<string, unknown[]>];

  const lastRun   = ((runsData as { dag_runs?: Record<string, unknown>[] }).dag_runs ?? [])[0];
  const successRun = ((successRunsData as { dag_runs?: Record<string, unknown>[] }).dag_runs ?? [])[0];

  return {
    dag_id: dagId,
    schedule_interval:   (dagData.schedule_interval as string | null) ?? null,
    is_paused:           Boolean(dagData.is_paused),
    last_run_id:         (lastRun?.dag_run_id as string) ?? null,
    last_run_state:      (lastRun?.state as string) ?? null,
    last_run_start:      (lastRun?.start_date as string) ?? null,
    last_success_run_id: (successRun?.dag_run_id as string) ?? null,
  };
}

// ── Task structure ────────────────────────────────────────────────────────────

export async function fetchDagTasks(baseUrl: string, dagId: string): Promise<AirflowTask[]> {
  const data = await apiFetch(baseUrl, `/dags/${enc(dagId)}/tasks`) as Record<string, unknown>;
  const tasks = (data.tasks ?? []) as Record<string, unknown>[];
  return tasks.map(t => ({
    task_id:              String(t.task_id ?? ''),
    operator:             String((t.class_ref as Record<string, unknown>)?.class_name ?? ''),
    downstream_task_ids:  (t.downstream_task_ids as string[]) ?? [],
    state:                null,
  }));
}

// ── Task instance states ──────────────────────────────────────────────────────

export async function fetchTaskStates(
  baseUrl: string,
  dagId: string,
  runId: string,
): Promise<Map<string, TaskState>> {
  const data = await apiFetch(
    baseUrl,
    `/dags/${enc(dagId)}/dagRuns/${enc(runId)}/taskInstances`,
  ) as Record<string, unknown>;

  const instances = (data.task_instances ?? []) as Record<string, unknown>[];
  const map = new Map<string, TaskState>();
  instances.forEach(ti => {
    map.set(String(ti.task_id), (ti.state as TaskState) ?? null);
  });
  return map;
}

// ── Full DAG load ─────────────────────────────────────────────────────────────

/**
 * Fetches DAG metadata, task structure, and task states from the last run
 * in three parallel API calls.
 */
export async function loadDag(
  baseUrl: string,
  dagId: string,
): Promise<{ meta: DagMeta; tasks: AirflowTask[] }> {
  const [meta, tasks] = await Promise.all([
    fetchDagMeta(baseUrl, dagId),
    fetchDagTasks(baseUrl, dagId),
  ]);

  // Populate task states from the most recent run (any state, for display)
  if (meta.last_run_id) {
    try {
      const stateMap = await fetchTaskStates(baseUrl, dagId, meta.last_run_id);
      tasks.forEach(t => {
        t.state = stateMap.get(t.task_id) ?? null;
      });
    } catch {
      // Non-fatal: states simply won't show
    }
  }

  return { meta, tasks };
}

// ── Recent DAG runs ───────────────────────────────────────────────────────────

/** Returns the last `limit` DAG runs (any state) sorted newest-first. */
export async function fetchRecentRuns(
  baseUrl: string,
  dagId: string,
  limit = 5,
): Promise<DagRun[]> {
  const data = await apiFetch(baseUrl, `/dags/${enc(dagId)}/dagRuns`, {
    limit: String(limit), order_by: '-execution_date',
  }) as Record<string, unknown>;
  const runs = (data.dag_runs ?? []) as Record<string, unknown>[];
  return runs.map(r => ({
    run_id:         String(r.dag_run_id ?? ''),
    state:          String(r.state ?? ''),
    execution_date: String(r.execution_date ?? ''),
    start_date:     (r.start_date as string) ?? null,
  }));
}

// ── Task SQL ──────────────────────────────────────────────────────────────────

/**
 * Fetches rendered SQL for a single task.
 * Strategy:
 *  1. If preferRunId is given, try that run first for rendered SQL.
 *  2. Fall back to last 10 successful runs if rendered not found.
 *  3. Always try raw task definition as a fallback.
 *  4. Apply bestSql() + formatSql().
 */
export async function fetchTaskSql(
  baseUrl: string,
  dagId: string,
  taskId: string,
  preferRunId?: string | null,
): Promise<TaskSqlResult> {
  let rawSql: string | null = null;
  let renderedSql: string | null = null;
  let renderedTruncated = false;

  // Attempt 1: raw SQL from task definition
  try {
    const taskDef = await apiFetch(baseUrl, `/dags/${enc(dagId)}/tasks/${enc(taskId)}`) as Record<string, unknown>;
    rawSql = extractSql(taskDef);

    if (!rawSql) {
      for (const key of ['sql', 'query', 'bql']) {
        const val = taskDef[key];
        if (typeof val === 'string' && isSqlFilePath(val)) {
          rawSql = null;
          break;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Attempt 2: rendered SQL — try preferRunId first, then walk recent successful runs
  const tryRenderFromRun = async (runId: string): Promise<boolean> => {
    try {
      const ti = await apiFetch(
        baseUrl,
        `/dags/${enc(dagId)}/dagRuns/${enc(runId)}/taskInstances/${enc(taskId)}`,
      );
      const sql = extractRenderedSql(ti);
      const trunc = wasRenderedTruncated(ti);
      if (sql) { renderedSql = sql; renderedTruncated = trunc; return true; }
    } catch { /* task not in this run */ }
    return false;
  };

  if (preferRunId) {
    await tryRenderFromRun(preferRunId);
  }

  if (!renderedSql) {
    try {
      const runsData = await apiFetch(baseUrl, `/dags/${enc(dagId)}/dagRuns`, {
        limit: '10', order_by: '-execution_date', state: 'success',
      }) as Record<string, unknown>;
      const runs = (runsData.dag_runs ?? []) as Record<string, unknown>[];

      for (const run of runs) {
        const runId = String(run.dag_run_id ?? '');
        if (!runId || runId === preferRunId) continue; // skip if already tried
        if (await tryRenderFromRun(runId)) break;
      }
    } catch {
      // Non-fatal
    }
  }

  const chosen = bestSql(rawSql, renderedSql, renderedTruncated);
  if (!chosen) return { sql: null, source: 'none' };

  const source: TaskSqlResult['source'] = renderedSql && !renderedTruncated ? 'rendered' : 'raw';
  return { sql: formatSql(chosen), source };
}
