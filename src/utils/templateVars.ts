/**
 * {{ placeholder }} substitution for SQL files in the batch optimizer.
 * Values come from user-supplied flat JSON files ({"key": "value", …}).
 * The same key appearing in several JSON files is surfaced as a conflict the
 * user resolves once per batch; placeholders with no value anywhere are
 * flagged per SQL file before the run starts.
 */

export interface VarFile {
  name:   string;
  values: Record<string, string>;
  errors: string[];   // keys skipped because their value wasn't a primitive, or parse failure
}

export interface VarCandidate {
  file:  string;
  value: string;
}

/** key → every JSON file that defines it, in load order. */
export type VarIndex = Map<string, VarCandidate[]>;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

const PAIR_RE = /"((?:[^"\\]|\\.)+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;

/**
 * Parses one flat key/value file. Strict JSON ({"key": "value"}) is tried
 * first; if that fails — e.g. ("key": "value") with parentheses, no outer
 * braces, or trailing commas — it falls back to scanning "key": value pairs.
 * Nested objects/arrays are rejected per key, not for the whole file. A key
 * repeated inside one file is flagged (the last value wins, as in JSON).
 */
export function parseVarFile(name: string, text: string): VarFile {
  const errors: string[] = [];
  const values: Record<string, string> = {};

  // Duplicate keys within the file — JSON.parse would silently keep the last one.
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)+)"\s*:/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) errors.push(`"${k}" appears ${n} times in this file — last value used.`);

  let raw: unknown;
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^\(/, '{').replace(/\)$/, '}'),
    trimmed.startsWith('{') ? trimmed : `{${trimmed}}`,
  ].map(t => t.replace(/,\s*([}\]])/g, '$1'));   // tolerate trailing commas
  for (const c of candidates) {
    try { raw = JSON.parse(c); break; } catch { /* try next form */ }
  }

  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { name, values: {}, errors: ['Expected key/value pairs like {"key": "value"}.'] };
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        values[k] = v === null ? 'NULL' : String(v);
      } else {
        errors.push(`"${k}": nested objects/arrays are not supported — skipped.`);
      }
    }
    return { name, values, errors };
  }

  // Lenient fallback: pick out "key": value pairs wherever they appear.
  for (const m of text.matchAll(PAIR_RE)) {
    const v = JSON.parse(m[2]) as string | number | boolean | null;
    values[JSON.parse(`"${m[1]}"`) as string] = v === null ? 'NULL' : String(v);
  }
  if (!Object.keys(values).length) {
    return { name, values, errors: ['No "key": "value" pairs found in this file.'] };
  }
  errors.push(`Not strict JSON — read ${Object.keys(values).length} "key": value pair(s) leniently. Check they look right.`);
  return { name, values, errors };
}

export function buildVarIndex(files: VarFile[]): VarIndex {
  const index: VarIndex = new Map();
  for (const f of files) {
    for (const [k, value] of Object.entries(f.values)) {
      const list = index.get(k) ?? [];
      list.push({ file: f.name, value });
      index.set(k, list);
    }
  }
  return index;
}

/** Keys defined in more than one JSON file — the user must pick which file wins. */
export function findConflicts(index: VarIndex): [string, VarCandidate[]][] {
  return [...index.entries()].filter(([, c]) => c.length > 1).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Collapses the index to one value per key. `choices` maps a conflicting key
 * to the JSON file the user picked; unresolved conflicts are left out so the
 * SQL files using them show up as "missing" until the user decides.
 */
export function resolveVars(index: VarIndex, choices: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, cands] of index) {
    if (cands.length === 1) out[k] = cands[0].value;
    else {
      const picked = cands.find(c => c.file === choices[k]);
      if (picked) out[k] = picked.value;
    }
  }
  return out;
}

/** Distinct placeholder names used in a SQL template. */
export function extractPlaceholders(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(PLACEHOLDER_RE)) names.add(m[1]);
  return [...names];
}

/**
 * Template syntax this substitution can't handle — {% %} blocks, {# #}
 * comments, and {{ }} expressions that aren't a bare variable name (filters
 * like {{ ds | replace('-', '') }}, macros, arithmetic). Returned so the file
 * can be flagged up front instead of failing later at the dry run.
 */
export function unsupportedTemplating(sql: string): string[] {
  const found = new Set<string>();
  for (const m of sql.matchAll(/\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|\{\{[\s\S]*?\}\}/g)) {
    if (m[0].startsWith('{{') && /^\{\{\s*[A-Za-z_][\w.]*\s*\}\}$/.test(m[0])) continue;
    found.add(m[0].replace(/\s+/g, ' ').slice(0, 60));
  }
  return [...found];
}

export function missingVars(sql: string, vars: Record<string, string>): string[] {
  return extractPlaceholders(sql).filter(n => !(n in vars));
}

export function renderTemplate(sql: string, vars: Record<string, string>): string {
  return sql.replace(PLACEHOLDER_RE, (whole, name: string) => (name in vars ? vars[name] : whole));
}
