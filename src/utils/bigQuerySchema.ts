/**
 * Fetches CREATE TABLE DDL for tables referenced in a query, via BigQuery's
 * INFORMATION_SCHEMA.TABLES.ddl column — gives the SQL optimizer real column
 * names/types/partitioning/clustering instead of guessing from table names.
 */

import { getVertexToken } from './jwtAuth';
import { getToken } from './auth';
import type { VertexSettings } from './vertexAI';

export interface TableRef {
  project: string | null;
  dataset: string;
  table:   string;
}

const TABLE_REF_RE = /\b(?:FROM|JOIN)\s+`?([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){1,2})`?/gi;

/** Extracts fully-qualified table references (dataset.table or project.dataset.table) from SQL. */
export function extractTableRefs(sql: string): TableRef[] {
  const seen = new Map<string, TableRef>();
  let m: RegExpExecArray | null;
  TABLE_REF_RE.lastIndex = 0;
  while ((m = TABLE_REF_RE.exec(sql))) {
    const parts = m[1].split('.');
    const ref: TableRef = parts.length === 3
      ? { project: parts[0], dataset: parts[1], table: parts[2] }
      : { project: null, dataset: parts[0], table: parts[1] };
    const key = `${ref.project ?? ''}.${ref.dataset}.${ref.table}`;
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()];
}

async function getBigQueryToken(settings: VertexSettings): Promise<string> {
  return settings.authMode === 'account' ? getToken() : getVertexToken();
}

interface QueryResponse {
  jobComplete?: boolean;
  rows?: { f: { v: string }[] }[];
}

// ── Schema cache ──────────────────────────────────────────────────────────────
// A batch run touches the same tables from many files. DDL + metadata are
// cached per fully-qualified table for the life of the page (1 hour TTL), and
// the cache holds promises so parallel files requesting the same table share
// one in-flight request. Failed lookups are evicted so they're retried.

const SCHEMA_CACHE_TTL_MS = 60 * 60_000;

interface CacheEntry { at: number; value: Promise<string | null> }

const ddlCache  = new Map<string, CacheEntry>();
const metaCache = new Map<string, CacheEntry>();

function cacheGet(cache: Map<string, CacheEntry>, key: string): Promise<string | null> | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > SCHEMA_CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return e.value;
}

function cachePut(cache: Map<string, CacheEntry>, key: string, value: Promise<string | null>): void {
  cache.set(key, { at: Date.now(), value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
}

export function clearSchemaCache(): void {
  ddlCache.clear();
  metaCache.clear();
}

function qualifiedKey(ref: TableRef, settings: VertexSettings): string | null {
  const project = ref.project ?? settings.projectId;
  return project ? `${project}.${ref.dataset}.${ref.table}` : null;
}

/**
 * Fetches DDL for the given table refs — the CREATE statement includes
 * PARTITION BY / CLUSTER BY / OPTIONS, so the model sees real partitioning
 * and clustering. Uncached tables are grouped by project+dataset so each group
 * costs a single INFORMATION_SCHEMA query job. Refs without an explicit
 * project fall back to settings.projectId. The lookup jobs run (and bill) in
 * `jobProject` when given — the batch optimizer's billing project — otherwise
 * in each dataset's own project. Failures for individual groups (missing
 * permissions, wrong project, etc.) are collected as warnings rather than
 * aborting the whole batch — optimization should still proceed without DDL.
 */
export async function fetchTableDdls(
  refs: TableRef[],
  settings: VertexSettings,
  jobProject?: string,
): Promise<{ ddl: string; warnings: string[]; cacheHits: number }> {
  if (refs.length === 0) return { ddl: '', warnings: [], cacheHits: 0 };

  const warnings = new Set<string>();
  const pending: Promise<string | null>[] = [];
  let cacheHits = 0;

  const groups = new Map<string, { project: string; dataset: string; tables: string[] }>();
  for (const ref of refs) {
    const key = qualifiedKey(ref, settings);
    if (!key) continue;
    const hit = cacheGet(ddlCache, key);
    if (hit) { cacheHits++; pending.push(hit); continue; }
    const project  = ref.project ?? settings.projectId;
    const groupKey = `${project}.${ref.dataset}`;
    const group = groups.get(groupKey) ?? { project, dataset: ref.dataset, tables: [] };
    group.tables.push(ref.table);
    groups.set(groupKey, group);
  }

  for (const [groupKey, group] of groups) {
    const result = queryGroupDdls(group, settings, jobProject ?? group.project).catch((e: Error) => {
      throw new Error(`${groupKey}: ${e.message}`);
    });
    for (const table of group.tables) {
      const p = result.then(m => m.get(table) ?? null);
      cachePut(ddlCache, `${groupKey}.${table}`, p);
      pending.push(p);
    }
  }

  const ddls = await Promise.all(pending.map(p => p.catch((e: Error) => { warnings.add(e.message); return null; })));
  return { ddl: ddls.filter(Boolean).join('\n\n'), warnings: [...warnings], cacheHits };
}

async function queryGroupDdls(
  group:      { project: string; dataset: string; tables: string[] },
  settings:   VertexSettings,
  jobProject: string,
): Promise<Map<string, string>> {
  const token = await getBigQueryToken(settings);
  const tableList = group.tables.map(t => `'${t.replace(/'/g, "\\'")}'`).join(', ');
  const query = `SELECT table_name, ddl FROM \`${group.project}.${group.dataset}\`.INFORMATION_SCHEMA.TABLES WHERE table_name IN (${tableList})`;

  const resp = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${jobProject}/queries`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, useLegacySql: false }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${body.slice(0, 200) || resp.statusText}`);
  }
  const data = await resp.json() as QueryResponse;
  if (data.jobComplete === false) throw new Error('query timed out before completion');

  const out = new Map<string, string>();
  for (const row of data.rows ?? []) {
    const [name, ddl] = [row.f?.[0]?.v, row.f?.[1]?.v];
    if (name && ddl) out.set(name, ddl);
  }
  return out;
}

// ── Table size metadata ────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes} B`;
}

interface TableMetadataResponse {
  type?:                   string;   // TABLE, VIEW, MATERIALIZED_VIEW, EXTERNAL, SNAPSHOT
  numRows?:                string;
  numBytes?:               string;
  timePartitioning?:       { type?: string; field?: string };
  rangePartitioning?:      { field?: string; range?: { start?: string; end?: string; interval?: string } };
  clustering?:             { fields?: string[] };
  requirePartitionFilter?: boolean;
}

function describeTable(key: string, d: TableMetadataResponse): string {
  const parts: string[] = [];
  if (d.type === 'VIEW') parts.push('view (sizes of underlying tables not shown)');
  else {
    if (d.type && d.type !== 'TABLE') parts.push(d.type.toLowerCase().replace('_', ' '));
    parts.push(`~${Number(d.numRows ?? 0).toLocaleString()} rows, ~${formatBytes(Number(d.numBytes ?? 0))}`);
  }
  if (d.timePartitioning) {
    parts.push(`partitioned by ${d.timePartitioning.type ?? 'DAY'}(${d.timePartitioning.field ?? '_PARTITIONTIME'})`);
  } else if (d.rangePartitioning) {
    const r = d.rangePartitioning.range;
    parts.push(`range-partitioned on ${d.rangePartitioning.field} [${r?.start}..${r?.end} step ${r?.interval}]`);
  } else if (d.type !== 'VIEW') {
    parts.push('not partitioned');
  }
  if (d.requirePartitionFilter) parts.push('partition filter REQUIRED');
  if (d.clustering?.fields?.length) parts.push(`clustered by ${d.clustering.fields.join(', ')}`);
  return `-- \`${key}\`: ${parts.join(' · ')}`;
}

/**
 * Fetches per-table metadata via tables.get: approximate rows/bytes (for
 * join-order guidance — which side to broadcast vs. shuffle) plus an explicit
 * one-line summary of partitioning, required partition filters and clustering,
 * so the model doesn't have to dig them out of the DDL. Cached like DDL.
 * Failures are collected as warnings — metadata is a nice-to-have.
 */
export async function fetchTableSizes(
  refs: TableRef[],
  settings: VertexSettings,
): Promise<{ sizeInfo: string; warnings: string[]; cacheHits: number }> {
  if (refs.length === 0) return { sizeInfo: '', warnings: [], cacheHits: 0 };

  const warnings: string[] = [];
  let cacheHits = 0;

  const lines = await Promise.all(refs.map(async (ref) => {
    const key = qualifiedKey(ref, settings);
    if (!key) return null;
    let p = cacheGet(metaCache, key);
    if (p) cacheHits++;
    else {
      p = (async () => {
        const token = await getBigQueryToken(settings);
        const [project] = key.split('.');
        const resp = await fetch(
          `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${ref.dataset}/tables/${ref.table}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        return describeTable(key, await resp.json() as TableMetadataResponse);
      })();
      cachePut(metaCache, key, p);
    }
    return p.catch((e: Error) => { warnings.push(`${key}: ${e.message}`); return null; });
  }));

  return { sizeInfo: lines.filter(Boolean).join('\n'), warnings, cacheHits };
}

// ── Dry run ───────────────────────────────────────────────────────────────────

export interface SchemaField {
  name: string;
  type: string;
}

export interface DryRunResult {
  totalBytesProcessed: number;
  referencedTables:    TableRef[];
  schemaFields:         SchemaField[];
  statementType?:       string;   // SELECT, INSERT, MERGE, SCRIPT, … as resolved by BigQuery
  referencedRoutines?:  string[]; // UDFs / remote functions / TVFs the query calls
  error?:               string;
}

interface DryRunJobResponse {
  statistics?: {
    query?: {
      totalBytesProcessed?: string;
      statementType?: string;
      referencedTables?: { projectId: string; datasetId: string; tableId: string }[];
      referencedRoutines?: { projectId: string; datasetId: string; routineId: string }[];
      schema?: { fields?: { name: string; type: string }[] };
    };
  };
  status?: { errorResult?: { message: string } };
  error?:  { message: string };
}

/**
 * Dry-runs a query via jobs.insert(dryRun=true) — validates the SQL and
 * returns bytes-that-would-be-scanned, the resolved table list, and the
 * output schema, without executing the query or reading any data.
 * Used both to ground the optimization prompt in real cost figures and,
 * after optimization, to verify the rewrite didn't change the output shape.
 */
export async function dryRunQuery(
  sql:      string,
  settings: VertexSettings,
  project:  string = settings.projectId,   // project the dry-run job is created in
): Promise<DryRunResult> {
  if (!project) {
    return { totalBytesProcessed: 0, referencedTables: [], schemaFields: [], error: 'No project ID configured.' };
  }

  try {
    const token = await getBigQueryToken(settings);
    const resp = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configuration: { dryRun: true, query: { query: sql, useLegacySql: false } },
        }),
      },
    );

    const data = await resp.json() as DryRunJobResponse;

    if (!resp.ok) {
      return { totalBytesProcessed: 0, referencedTables: [], schemaFields: [], error: data.error?.message ?? `${resp.status} ${resp.statusText}` };
    }
    if (data.status?.errorResult) {
      return { totalBytesProcessed: 0, referencedTables: [], schemaFields: [], error: data.status.errorResult.message };
    }

    const q = data.statistics?.query;
    return {
      totalBytesProcessed: Number(q?.totalBytesProcessed ?? 0),
      referencedTables: (q?.referencedTables ?? []).map(t => ({ project: t.projectId, dataset: t.datasetId, table: t.tableId })),
      schemaFields: (q?.schema?.fields ?? []).map(f => ({ name: f.name, type: f.type })),
      statementType: q?.statementType,
      referencedRoutines: (q?.referencedRoutines ?? []).map(r => `${r.projectId}.${r.datasetId}.${r.routineId}`),
    };
  } catch (e) {
    return { totalBytesProcessed: 0, referencedTables: [], schemaFields: [], error: (e as Error).message };
  }
}

/** True if two dry-run output schemas have the same columns, in the same order. */
export function schemasEqual(a: SchemaField[], b: SchemaField[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((f, i) => f.name === b[i].name && f.type === b[i].type);
}

// ── Billing projects ──────────────────────────────────────────────────────────

/**
 * Lists the projects the current credentials can see (Cloud Resource Manager),
 * for the batch optimizer's billing-project picker. Returns [] on any failure —
 * the picker falls back to free-text entry.
 */
export async function listProjects(settings: VertexSettings): Promise<string[]> {
  try {
    const token = await getBigQueryToken(settings);
    const ids: string[] = [];
    let pageToken = '';
    do {
      const url = new URL('https://cloudresourcemanager.googleapis.com/v1/projects');
      url.searchParams.set('filter', 'lifecycleState:ACTIVE');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) break;
      const data = await resp.json() as { projects?: { projectId: string }[]; nextPageToken?: string };
      ids.push(...(data.projects ?? []).map(p => p.projectId));
      pageToken = data.nextPageToken ?? '';
    } while (pageToken && ids.length < 1000);
    return ids.sort();
  } catch {
    return [];
  }
}

// ── Real-run benchmark ────────────────────────────────────────────────────────

/**
 * Prefixes 2-part `dataset.table` references with `project`, but only for
 * tables BigQuery itself resolved (dry-run referencedTables) and only right
 * after FROM/JOIN — so a column reference like `t.col` is never touched. Needed when the benchmark runs in a
 * different billing project: unqualified datasets resolve against the job's
 * project, which would otherwise point at the wrong tables.
 */
export function qualifyTableRefs(sql: string, refs: TableRef[], project: string): string {
  let out = sql;
  for (const ref of refs) {
    if (ref.project !== project) continue;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const re = new RegExp(`(\\b(?:FROM|JOIN)\\s+)(\`?)${esc(ref.dataset)}\\.${esc(ref.table)}\\2(?![\\w.-])`, 'gi');
    out = out.replace(re, `$1\`${project}.${ref.dataset}.${ref.table}\``);
  }
  return out;
}

export interface BenchmarkResult {
  jobId:               string;
  slotMs:              number;
  totalBytesProcessed: number;
  elapsedMs:           number;
  rowCount:            number;
  fingerprint:         string;   // order-independent checksum of all result rows
  error?:              string;
}

interface JobResource {
  jobReference?: { jobId: string; location?: string };
  status?:       { state?: string; errorResult?: { message: string } };
  statistics?:   {
    startTime?: string;
    endTime?:   string;
    query?: { totalSlotMs?: string; totalBytesProcessed?: string };
  };
  error?: { message: string };
}

// ── Execution safety ──────────────────────────────────────────────────────────

/**
 * The single rule for whether a query may ever be executed for real.
 * Executing must never change data anywhere, so only a plain SELECT
 * qualifies — as classified by BigQuery's own dry run, never by parsing:
 *   - statementType must be exactly SELECT (DML, DDL, MERGE, EXPORT DATA,
 *     CALL and multi-statement SCRIPTs are all rejected)
 *   - no routine calls: a UDF may be a remote function that runs arbitrary
 *     code in a Cloud Function, which could write data anywhere
 *   - no EXTERNAL_QUERY, which runs SQL on an external database (Cloud SQL)
 * Returns the reason execution is refused, or null if it's allowed.
 */
export function executionBlocker(sql: string, dry: DryRunResult): string | null {
  if (dry.error)                         return `dry run failed: ${dry.error}`;
  if (dry.statementType !== 'SELECT')    return `${dry.statementType ?? 'non-SELECT'} statements are never executed`;
  if (dry.referencedRoutines?.length)    return `calls user-defined/remote functions (${dry.referencedRoutines.join(', ')}) — never executed`;
  if (/\bEXTERNAL_QUERY\s*\(/i.test(sql)) return 'uses EXTERNAL_QUERY (runs SQL on an external database) — never executed';
  return null;
}

/** Removes trailing semicolons and trailing -- comments so the SQL can be nested in a subquery. */
function stripTrailing(sql: string): string {
  let s = sql.trimEnd();
  for (;;) {
    const next = s.replace(/;\s*$/, '').replace(/\n[ \t]*--[^\n]*$/, '').trimEnd();
    if (next === s) return s;
    s = next;
  }
}

/**
 * Per-row value to fingerprint. FLOAT64 columns are rounded first: float
 * SUM/AVG in BigQuery isn't bit-for-bit deterministic across plans, so an
 * equivalent rewrite could otherwise show up as "results differ". Falls back
 * to the whole row when columns are unnamed (f0_) and can't be referenced.
 */
function rowExpression(fields: SchemaField[]): string {
  const hasFloat = fields.some(f => f.type === 'FLOAT' || f.type === 'FLOAT64');
  if (!hasFloat || fields.some(f => /^f\d+_$/.test(f.name))) return 'TO_JSON_STRING(t)';
  const cols = fields.map(f =>
    f.type === 'FLOAT' || f.type === 'FLOAT64'
      ? `ROUND(t.\`${f.name}\`, 6) AS \`${f.name}\``
      : `t.\`${f.name}\``,
  );
  return `TO_JSON_STRING(STRUCT(${cols.join(', ')}))`;
}

/**
 * Runs a SELECT for real (cache disabled) inside a checksum wrapper, so one
 * execution yields both the cost (slot-ms, bytes) and a fingerprint of the
 * full result set: row count + BIT_XOR and a modular SUM of per-row
 * FARM_FINGERPRINTs (the SUM catches duplicate rows that XOR cancels out).
 * Both versions of a query pay the same wrapper overhead, so the slot-time
 * comparison stays fair.
 *
 * Safety: immediately before executing, the EXACT text that will run (wrapper
 * included) is dry-run in the billing project and must pass executionBlocker —
 * so even if a caller passed something else, nothing but a plain SELECT is
 * ever executed. The job has no destination table, so results only go to
 * BigQuery's anonymous temporary result table.
 *
 * Completion is awaited with getQueryResults long-polls rather than timers —
 * Chrome throttles timers in background tabs to once a minute, and a batch
 * run usually happens in a tab the user isn't looking at.
 */
export async function benchmarkSelect(
  sql:            string,
  schemaFields:   SchemaField[],
  billingProject: string,
  settings:       VertexSettings,
  timeoutMs:      number,
  signal?:        AbortSignal,
): Promise<BenchmarkResult> {
  const empty = { jobId: '', slotMs: 0, totalBytesProcessed: 0, elapsedMs: 0, rowCount: 0, fingerprint: '' };
  const wrapped =
`WITH __fp AS (
  SELECT FARM_FINGERPRINT(${rowExpression(schemaFields)}) AS h
  FROM (
${stripTrailing(sql)}
  ) AS t
)
SELECT COUNT(*) AS row_count, BIT_XOR(h) AS fp_xor, SUM(MOD(h, 1000000007)) AS fp_sum
FROM __fp`;

  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${billingProject}`;
  // Fresh headers per request: a benchmark can outlive a 1-hour access token.
  const headers = async () => ({ Authorization: `Bearer ${await getBigQueryToken(settings)}`, 'Content-Type': 'application/json' });

  const guard = await dryRunQuery(wrapped, settings, billingProject);
  const blocked = executionBlocker(wrapped, guard);
  if (blocked) return { ...empty, error: `Refused to execute — ${blocked}` };

  let job: JobResource;
  try {
    const resp = await fetch(`${base}/jobs`, {
      method: 'POST', headers: await headers(), signal,
      body: JSON.stringify({
        configuration: {
          query: { query: wrapped, useLegacySql: false, useQueryCache: false },
          jobTimeoutMs: String(timeoutMs),
          labels: { source: 'airflow-dag-viewer-benchmark' },
        },
      }),
    });
    job = await resp.json() as JobResource;
    if (!resp.ok) return { ...empty, error: job.error?.message ?? `${resp.status} ${resp.statusText}` };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }

  const jobId    = job.jobReference!.jobId;
  const location = job.jobReference!.location;
  const locParam = location ? `location=${encodeURIComponent(location)}&` : '';

  // If the caller aborts (batch cancelled or tab closing), stop the job
  // server-side too so it doesn't keep burning slots. The token is read from
  // storage before the abort can happen, and keepalive lets the cancel request
  // outlive a closing tab.
  const cancelHeaders = await headers();
  const onAbort = () => {
    fetch(`${base}/jobs/${jobId}/cancel?${locParam}`, { method: 'POST', headers: cancelHeaders, keepalive: true }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let results: QueryResponse & { error?: { message: string } };
    for (;;) {
      const r = await fetch(`${base}/queries/${jobId}?${locParam}maxResults=1&timeoutMs=10000`, { headers: await headers(), signal });
      results = await r.json() as QueryResponse & { error?: { message: string } };
      if (!r.ok) return { ...empty, jobId, error: results.error?.message ?? `${r.status} ${r.statusText}` };
      if (results.jobComplete) break;
    }

    const jr = await fetch(`${base}/jobs/${jobId}?${locParam}`, { headers: await headers(), signal });
    job = await jr.json() as JobResource;
    if (!jr.ok) return { ...empty, jobId, error: job.error?.message ?? `${jr.status} ${jr.statusText}` };
    if (job.status?.errorResult) return { ...empty, jobId, error: job.status.errorResult.message };

    const row = results.rows?.[0]?.f ?? [];
    const st  = job.statistics;
    return {
      jobId,
      slotMs:              Number(st?.query?.totalSlotMs ?? 0),
      totalBytesProcessed: Number(st?.query?.totalBytesProcessed ?? 0),
      elapsedMs:           st?.startTime && st?.endTime ? Number(st.endTime) - Number(st.startTime) : 0,
      rowCount:            Number(row[0]?.v ?? 0),
      fingerprint:         `${row[1]?.v ?? 'null'}:${row[2]?.v ?? 'null'}`,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function formatSlotHours(slotMs: number): string {
  const h = slotMs / 3_600_000;
  if (h >= 1)     return `${h.toFixed(2)} slot-h`;
  if (h >= 0.01)  return `${h.toFixed(3)} slot-h`;
  return `${(slotMs / 1000).toFixed(1)} slot-s`;
}
