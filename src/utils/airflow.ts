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
import type { AirflowTask, DagMeta, TaskSqlResult, TaskState } from '../types';

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

// ── Task SQL ──────────────────────────────────────────────────────────────────

/**
 * Fetches rendered SQL for a single task.
 * Strategy (mirrors get_task_sql in composer_tools.py):
 *  1. Walk last 10 successful dag runs → GET taskInstances/{task_id} → extract rendered_fields
 *  2. If still nothing, GET /dags/{dag_id}/tasks/{task_id} → extract raw SQL
 *  3. Apply bestSql() + formatSql()
 */
export async function fetchTaskSql(
  baseUrl: string,
  dagId: string,
  taskId: string,
): Promise<TaskSqlResult> {
  let rawSql: string | null = null;
  let renderedSql: string | null = null;
  let renderedTruncated = false;

  // Attempt 1: raw SQL from task definition
  try {
    const taskDef = await apiFetch(baseUrl, `/dags/${enc(dagId)}/tasks/${enc(taskId)}`) as Record<string, unknown>;
    rawSql = extractSql(taskDef);

    // Note if the sql field is a file path reference — we can't fetch the file
    // from within the extension, but the rendered fields should have the content.
    if (!rawSql) {
      for (const key of ['sql', 'query', 'bql']) {
        const val = taskDef[key];
        if (typeof val === 'string' && isSqlFilePath(val)) {
          rawSql = null; // will come from rendered_fields
          break;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Attempt 2: rendered SQL from last successful runs
  try {
    const runsData = await apiFetch(baseUrl, `/dags/${enc(dagId)}/dagRuns`, {
      limit: '10', order_by: '-execution_date', state: 'success',
    }) as Record<string, unknown>;
    const runs = (runsData.dag_runs ?? []) as Record<string, unknown>[];

    for (const run of runs) {
      const runId = String(run.dag_run_id ?? '');
      if (!runId) continue;
      try {
        const ti = await apiFetch(
          baseUrl,
          `/dags/${enc(dagId)}/dagRuns/${enc(runId)}/taskInstances/${enc(taskId)}`,
        );
        renderedSql = extractRenderedSql(ti);
        renderedTruncated = wasRenderedTruncated(ti);
        if (renderedSql) break;
      } catch {
        continue; // task may not have run in this DAG run
      }
    }
  } catch {
    // Non-fatal
  }

  const chosen = bestSql(rawSql, renderedSql, renderedTruncated);
  if (!chosen) return { sql: null, source: 'none' };

  const source: TaskSqlResult['source'] = renderedSql && !renderedTruncated ? 'rendered' : 'raw';
  return { sql: formatSql(chosen), source };
}
