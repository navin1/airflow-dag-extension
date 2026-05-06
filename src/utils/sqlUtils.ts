/**
 * SQL extraction and formatting utilities — ported from work_agent's
 * core/sql_formatter.py and tools/composer_tools.py.
 *
 * Key operations:
 *  1. sanitizeSql    — unescape all escape sequences Airflow injects
 *  2. extractSql     — recursively pull SQL out of rendered_fields dicts
 *  3. extractFromTruncatedConfig — handle Airflow's "Truncated …" repr strings
 *  4. formatSql      — run sql-formatter (BigQuery dialect) + data-loss guardrail
 *  5. bestSql        — pick the richer of raw vs rendered SQL
 */

import { format } from 'sql-formatter';

const SQL_RE = /\b(SELECT|WITH|INSERT|MERGE|UPDATE|DELETE|CREATE|DECLARE|SET|BEGIN|EXCEPTION)\b/i;

// ── 1. Sanitize ───────────────────────────────────────────────────────────────

export function sanitizeSql(sql: string): string {
  return (
    sql
      // Double-escaped sequences from Airflow repr → actual chars
      .replace(/\\\\n/g,  '\n')
      .replace(/\\\\t/g,  '\t')
      .replace(/\\\\r/g,  '')
      // Single-escaped sequences
      .replace(/\\n/g,    '\n')
      .replace(/\\r/g,    '')
      .replace(/\\t/g,    '\t')
      // Non-breaking spaces (literal and escaped)
      .replace(/ /g, ' ')
      .replace(/\\xa0/g,  ' ')
      .replace(/\\xao/g,  ' ')   // common typo in data
      // Escaped quotes remaining after Airflow repr parsing
      .replace(/\\'/g,    "'")
      .replace(/\\"/g,    '"')
      // Any remaining double-backslashes
      .replace(/\\\\/g,   '\\')
      // Normalize carriage returns
      .replace(/\r/g,     '')
      // Normalize tabs to 4 spaces for formatter
      .replace(/\t/g,     '    ')
  );
}

// ── 2. Extract SQL from a rendered_fields dict ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractSql(obj: any, depth = 0): string | null {
  if (depth > 6) return null;

  if (typeof obj === 'string') {
    const s = obj.trim();
    return s.length > 20 && SQL_RE.test(s) ? s : null;
  }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    // Priority fields
    for (const field of ['sql', 'query', 'bql']) {
      const r = extractSql(obj[field], depth + 1);
      if (r) return r;
    }
    // BigQueryInsertJobOperator nesting: configuration.query.query
    if (obj.configuration && typeof obj.configuration === 'object') {
      const q = obj.configuration.query;
      if (q && typeof q === 'object') {
        const r = extractSql(q.query, depth + 1);
        if (r) return r;
      }
    }
    // General scan (skip already-checked keys)
    for (const [key, val] of Object.entries(obj)) {
      if (['sql', 'query', 'bql', 'configuration'].includes(key)) continue;
      const r = extractSql(val, depth + 1);
      if (r) return r;
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = extractSql(item, depth + 1);
      if (r) return r;
    }
  }

  return null;
}

// ── 3. Extract from Airflow's truncated repr strings ─────────────────────────

/**
 * Handles Airflow's "Truncated …" configuration field that appears when
 * the rendered configuration dict is too large to store as JSON.
 * After JSON parsing, the string contains escaped sequences like \'query\': \'SQL...\'.
 */
export function extractFromTruncatedConfig(s: string): string | null {
  if (typeof s !== 'string' || !s.startsWith('Truncated')) return null;

  const candidates: [string, string][] = [
    ["\\'query\\': \\'", "\\'"],   // escaped form
    ["'query': '",        "'"],    // plain form
    ['"query": "',        '"'],    // double-quote form
  ];

  for (const [marker, endQuote] of candidates) {
    const idx = s.lastIndexOf(marker);
    if (idx === -1) continue;

    let raw = s.slice(idx + marker.length);
    // Unescape Airflow repr sequences (same mapping as Python code)
    raw = raw
      .replace(/\\\\n/g, '\n')
      .replace(/\\\\t/g, '\t')
      .replace(/\\'/g,   "'")
      .replace(/\\"/g,   '"')
      .replace(/\\\\/g,  '\\');

    // Strip trailing closing quote + truncation ellipsis
    raw = raw.replace(new RegExp(escapeRegex(endQuote) + '\\s*\\.\\.\\.\\s*$'), '').trim();
    raw = raw.replace(/\s*\.\.\.\s*$/, '').trim();

    if (raw.length > 20 && SQL_RE.test(raw)) return raw;
  }
  return null;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 4. Unwrap rendered_fields ─────────────────────────────────────────────────

/** Airflow 2.5+ nests rendered values under a 'rendered_fields' key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapRenderedFields(inst: any): any {
  if (inst?.rendered_fields && typeof inst.rendered_fields === 'object') {
    return inst.rendered_fields;
  }
  return inst;
}

/** True when Airflow stored rendered_fields as a truncated repr string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wasRenderedTruncated(inst: any): boolean {
  const fields = unwrapRenderedFields(inst);
  const cfg = fields?.configuration;
  return typeof cfg === 'string' && cfg.startsWith('Truncated');
}

/**
 * Full SQL extraction pipeline for a task instance API response.
 * Mirrors _extract_rendered_sql() from composer_tools.py.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractRenderedSql(inst: any): string | null {
  const fields = unwrapRenderedFields(inst);

  // Direct extraction from rendered fields dict
  const direct = extractSql(fields);
  if (direct) return direct;

  // Airflow truncated configuration repr string
  const cfgVal = fields?.configuration;
  if (typeof cfgVal === 'string') {
    const fromCfg = extractFromTruncatedConfig(cfgVal);
    if (fromCfg) return fromCfg;
  }

  return null;
}

// ── 5. Pick the best SQL between raw and rendered ─────────────────────────────

export function bestSql(
  raw: string | null,
  rendered: string | null,
  renderedTruncated = false,
): string | null {
  if (renderedTruncated && raw) return raw;
  if (raw && rendered) return raw.length >= rendered.length ? raw : rendered;
  return raw ?? rendered;
}

// ── 6. Format SQL with sql-formatter ─────────────────────────────────────────

export function formatSql(sql: string): string {
  if (!sql?.trim()) return sql;
  const sanitized = sanitizeSql(sql);

  try {
    const formatted = format(sanitized, {
      language: 'bigquery',
      tabWidth: 2,
      useTabs: false,
      keywordCase: 'upper',
      indentStyle: 'standard',
      logicalOperatorNewline: 'before',
      expressionWidth: 80,
    });

    // Data-loss guardrail: revert if formatted lost > 15% of content
    const strippedFormatted = formatted.replace(/\s+/g, '');
    const strippedSanitized = sanitized.replace(/\s+/g, '');
    if (!formatted.trim() || strippedFormatted.length < strippedSanitized.length * 0.85) {
      return sanitized;
    }
    return formatted;
  } catch {
    try {
      return format(sanitized, { language: 'sql', tabWidth: 2, keywordCase: 'upper' });
    } catch {
      return sanitized;
    }
  }
}

/** True if the value looks like a .sql file path reference (not inline SQL). */
export function isSqlFilePath(val: string | null | undefined): boolean {
  if (!val) return false;
  return val.trim().toLowerCase().endsWith('.sql') && !SQL_RE.test(val);
}
