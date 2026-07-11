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

/**
 * Fetches DDL for the given table refs, grouped by project+dataset so each
 * group costs a single INFORMATION_SCHEMA query job. Refs without an explicit
 * project fall back to settings.projectId. Failures for individual groups
 * (missing permissions, wrong project, etc.) are collected as warnings rather
 * than aborting the whole batch — optimization should still proceed without DDL.
 */
export async function fetchTableDdls(
  refs: TableRef[],
  settings: VertexSettings,
): Promise<{ ddl: string; warnings: string[] }> {
  if (refs.length === 0) return { ddl: '', warnings: [] };

  const token = await getBigQueryToken(settings);
  const warnings: string[] = [];
  const ddls: string[] = [];

  const groups = new Map<string, { project: string; dataset: string; tables: string[] }>();
  for (const ref of refs) {
    const project = ref.project ?? settings.projectId;
    if (!project) continue;
    const key = `${project}.${ref.dataset}`;
    const group = groups.get(key) ?? { project, dataset: ref.dataset, tables: [] };
    group.tables.push(ref.table);
    groups.set(key, group);
  }

  await Promise.all([...groups.entries()].map(async ([key, group]) => {
    const tableList = group.tables.map(t => `'${t.replace(/'/g, "\\'")}'`).join(', ');
    const query = `SELECT ddl FROM \`${group.project}.${group.dataset}\`.INFORMATION_SCHEMA.TABLES WHERE table_name IN (${tableList})`;

    try {
      const resp = await fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${group.project}/queries`,
        {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, useLegacySql: false }),
        },
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        warnings.push(`${key}: ${resp.status} ${body.slice(0, 200) || resp.statusText}`);
        return;
      }

      const data = await resp.json() as QueryResponse;
      if (data.jobComplete === false) {
        warnings.push(`${key}: query timed out before completion`);
        return;
      }
      for (const row of data.rows ?? []) {
        const ddl = row.f?.[0]?.v;
        if (ddl) ddls.push(ddl);
      }
    } catch (e) {
      warnings.push(`${key}: ${(e as Error).message}`);
    }
  }));

  return { ddl: ddls.join('\n\n'), warnings };
}

// ── Table size metadata ────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes} B`;
}

interface TableMetadataResponse {
  numRows?:  string;
  numBytes?: string;
}

/**
 * Fetches approximate row/byte counts for the given tables via tables.get.
 * Sizes matter for join-order guidance (which side to broadcast vs. shuffle)
 * in a way DDL alone doesn't capture. Failures are collected as warnings and
 * simply omitted from the result — sizing is a nice-to-have, not required.
 */
export async function fetchTableSizes(
  refs: TableRef[],
  settings: VertexSettings,
): Promise<{ sizeInfo: string; warnings: string[] }> {
  if (refs.length === 0) return { sizeInfo: '', warnings: [] };

  const token = await getBigQueryToken(settings);
  const warnings: string[] = [];
  const lines: string[] = [];

  await Promise.all(refs.map(async (ref) => {
    const project = ref.project ?? settings.projectId;
    if (!project) return;
    const key = `${project}.${ref.dataset}.${ref.table}`;

    try {
      const resp = await fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${ref.dataset}/tables/${ref.table}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) {
        warnings.push(`${key}: ${resp.status} ${resp.statusText}`);
        return;
      }
      const data = await resp.json() as TableMetadataResponse;
      const rows  = Number(data.numRows ?? 0);
      const bytes = Number(data.numBytes ?? 0);
      lines.push(`-- \`${key}\`: ~${rows.toLocaleString()} rows, ~${formatBytes(bytes)}`);
    } catch (e) {
      warnings.push(`${key}: ${(e as Error).message}`);
    }
  }));

  return { sizeInfo: lines.join('\n'), warnings };
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
  error?:               string;
}

interface DryRunJobResponse {
  statistics?: {
    query?: {
      totalBytesProcessed?: string;
      referencedTables?: { projectId: string; datasetId: string; tableId: string }[];
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
export async function dryRunQuery(sql: string, settings: VertexSettings): Promise<DryRunResult> {
  if (!settings.projectId) {
    return { totalBytesProcessed: 0, referencedTables: [], schemaFields: [], error: 'No project ID configured.' };
  }

  try {
    const token = await getBigQueryToken(settings);
    const resp = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${settings.projectId}/jobs`,
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
