/**
 * Vertex AI / Gemini API client.
 * Uses a GCP service-account Bearer token from jwtAuth.ts.
 * Model, region, and project are all configurable in Settings.
 */

import { getVertexToken, loadServiceAccount } from './jwtAuth';
import { getToken } from './auth';

export interface VertexSettings {
  model:     string;
  region:    string;
  projectId: string;
  authMode:  'json' | 'account';
}

// ── Storage helper ────────────────────────────────────────────────────────────

export async function loadVertexSettings(): Promise<VertexSettings> {
  const defaults: VertexSettings = {
    model:     'gemini-2.5-pro',
    region:    'us-central1',
    projectId: '',
    authMode:  'json',
  };

  if (typeof chrome === 'undefined' || !chrome.storage) return defaults;

  const stored = await new Promise<Record<string, string>>(r =>
    chrome.storage.sync.get(['vertexModel', 'vertexRegion', 'vertexProjectId', 'vertexAuthMode'], v =>
      r(v as Record<string, string>),
    ),
  );

  const authMode = (stored.vertexAuthMode ?? 'json') as 'json' | 'account';

  // Fall back to project_id from the service account JSON only in json mode
  let projectId = stored.vertexProjectId ?? '';
  if (!projectId && authMode === 'json') {
    const sa = await loadServiceAccount();
    projectId = sa?.project_id ?? '';
  }

  return {
    model:     stored.vertexModel  ?? defaults.model,
    region:    stored.vertexRegion ?? defaults.region,
    projectId: projectId           || defaults.projectId,
    authMode,
  };
}

// ── API call ──────────────────────────────────────────────────────────────────

function geminiEndpoint(settings: VertexSettings, method: 'generateContent' | 'streamGenerateContent'): string {
  // The global endpoint has no region prefix on the host.
  const host = settings.region === 'global' ? 'aiplatform.googleapis.com' : `${settings.region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${settings.projectId}/locations/${settings.region}/publishers/google/models/${settings.model}:${method}`;
}

async function geminiToken(settings: VertexSettings): Promise<string> {
  return settings.authMode === 'account' ? getToken() : getVertexToken();
}

const GENERATION_CONFIG = {
  temperature:     0.1,   // low temperature for deterministic SQL
  maxOutputTokens: 65536,
  topP:            0.8,
};

async function callGemini(prompt: string, settings: VertexSettings): Promise<string> {
  const token = await geminiToken(settings);

  const resp = await fetch(geminiEndpoint(settings, 'generateContent'), {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: GENERATION_CONFIG,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Vertex AI error (${resp.status}): ${body.slice(0, 300) || resp.statusText}`);
  }

  const data = await resp.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Vertex AI returned an empty response.');

  // Strip markdown code fences if the model wrapped the SQL
  return text
    .replace(/^```sql\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/**
 * Streams a JSON-mode Gemini response via streamGenerateContent (SSE),
 * calling onChunk with the accumulated text as it arrives so the UI can show
 * live progress. Retries 429/5xx with exponential backoff — a batch run
 * fires many requests and Vertex AI quotas are per-minute.
 */
async function callGeminiStreamJson(
  prompt:         string,
  responseSchema: object,
  settings:       VertexSettings,
  onChunk?:       (textSoFar: string) => void,
  signal?:        AbortSignal,
  onRetry?:       (attempt: number, waitMs: number, reason: string) => void,
): Promise<string> {
  const MAX_ATTEMPTS = 5;
  const backoff = (attempt: number) => Math.min(60_000, 2_000 * 2 ** (attempt - 1));

  for (let attempt = 1; ; attempt++) {
    let resp: Response;
    let text = '';
    let finishReason: string | undefined;
    let blockReason:  string | undefined;

    try {
      const token = await geminiToken(settings);
      resp = await fetch(`${geminiEndpoint(settings, 'streamGenerateContent')}?alt=sse`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { ...GENERATION_CONFIG, responseMimeType: 'application/json', responseSchema },
        }),
        signal,
      });

      if (!resp.ok || !resp.body) {
        const body = await resp.text().catch(() => '');
        const retryable = resp.status === 429 || resp.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          const waitMs = backoff(attempt);
          onRetry?.(attempt, waitMs, `HTTP ${resp.status}`);
          await sleep(waitMs, signal);
          continue;
        }
        throw new Error(`Vertex AI error (${resp.status}): ${body.slice(0, 300) || resp.statusText}`);
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const evt of events) {
          const dataLine = evt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          if (!dataLine) continue;
          const chunk = JSON.parse(dataLine) as {
            candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
            promptFeedback?: { blockReason?: string };
          };
          if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
          const cand = chunk.candidates?.[0];
          for (const part of cand?.content?.parts ?? []) {
            if (part.text && !part.thought) text += part.text;
          }
          if (cand?.finishReason) finishReason = cand.finishReason;
          onChunk?.(text);
        }
      }
    } catch (e) {
      // Network drop (fetch / stream read throws TypeError) — retry from scratch.
      // Aborts and our own errors propagate.
      if (e instanceof TypeError && !signal?.aborted && attempt < MAX_ATTEMPTS) {
        const waitMs = backoff(attempt);
        onRetry?.(attempt, waitMs, `connection error (${e.message})`);
        onChunk?.('');
        await sleep(waitMs, signal);
        continue;
      }
      throw e;
    }

    if (blockReason) throw new Error(`Vertex AI blocked the request (${blockReason}).`);
    if (finishReason === 'MAX_TOKENS') throw new Error('Vertex AI response was cut off (max output tokens reached) — the SQL file may be too large.');
    if (finishReason && finishReason !== 'STOP') throw new Error(`Vertex AI stopped early (finish reason: ${finishReason}).`);
    if (!text) throw new Error('Vertex AI returned an empty response.');
    return text;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const OPTIMIZATION_PROMPT = (
  sql: string,
  ddlContext?: string,
  costDiagnostics?: string,
  extra: { structured?: boolean; templateVars?: Record<string, string> } = {},
) => `\
You are a senior Google Cloud data engineer and SQL architect specializing in BigQuery.
Your task has two equally important parts: SELF-DOCUMENTATION and PERFORMANCE OPTIMIZATION.

━━━ PART 1 — SELF-DOCUMENTATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Add professional, production-grade documentation using only -- line comments (never /* */):

A) FILE-LEVEL HEADER  (place at the very top, before any SQL)
   Format exactly as shown — fill in every field based on what the SQL actually does:

   -- ============================================================
   -- Purpose : <one sentence: what business question this answers>
   -- Source  : <comma-separated list of source tables/views read>
   -- Output  : <what the result set / destination table represents>
   -- Notes   : <key assumptions, partition filters, or edge cases>
   -- ============================================================

B) STATEMENT-LEVEL ANNOTATIONS
   Add a single -- comment immediately above each:
   • WITH clause / individual CTE definition
   • SELECT, INSERT, UPDATE, DELETE, MERGE, or CREATE statement
   • Significant JOIN that is non-obvious in purpose
   Each annotation must describe the BUSINESS LOGIC (the "why"), not just
   restate the syntax. Keep each annotation ≤ 120 characters.

━━━ PART 2 — PERFORMANCE OPTIMIZATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Optimize the SQL for BigQuery cost and speed:
   • Apply partition and cluster pruning filters as early as possible
   • Eliminate SELECT *; reference only required columns
   • Push predicates before JOINs to reduce shuffle
   • Replace correlated subqueries with CTEs
   • Prefer QUALIFY over nested subqueries for window-function filters
   • Use APPROX_COUNT_DISTINCT where exact cardinality is not required

━━━ RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${extra.structured
  ? `- Respond with JSON matching the given schema. "optimizedSql" holds ONLY the final
  documented + optimized SQL (no markdown fences). "changes" lists every
  performance-relevant change (not the comments you added), each with the reason
  and its risk of altering results. "overallRisk" is the highest risk of any change.`
  : '- Return ONLY the final documented + optimized SQL. No explanations, no markdown.'}
- Preserve the original query's logic and result set exactly.
- Every CTE and every top-level statement must have its annotation — no exceptions.
- If the query is already optimal, still apply full documentation (Part 1 is mandatory).
${extra.templateVars ? `
━━━ TEMPLATE PLACEHOLDERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This SQL is a template: {{ name }} placeholders are substituted before it runs.
Keep EVERY placeholder exactly as written (same name, same {{ }} syntax) in the
optimized SQL — never inline its value. For reference, the current values are:
${Object.entries(extra.templateVars).map(([k, v]) => `  {{ ${k} }} = ${v}`).join('\n')}
` : ''}${ddlContext ? `
━━━ SCHEMA CONTEXT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The CREATE TABLE statements below are the actual DDL for tables referenced in
this query, followed by one line per table with its size, partitioning,
whether a partition filter is required, and clustering columns. Use them to
verify join keys and column types, and to add filters on the real partition
column and predicates on the leading clustering columns — never guess.

${ddlContext}
` : ''}${costDiagnostics ? `
━━━ CURRENT QUERY COST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${costDiagnostics}
Prioritize changes that reduce bytes scanned for the tables above over purely
cosmetic rewrites.
` : ''}
SQL:
${sql}`;

/**
 * Calls Vertex AI Gemini to optimize a BigQuery SQL query.
 * ddlContext, if provided, is the CREATE TABLE DDL (+ approx table sizes) of
 * tables referenced in the query (see bigQuerySchema.ts) — it grounds
 * join/partition suggestions in the real schema instead of the model
 * guessing from table names. costDiagnostics, if provided, is a BigQuery
 * dry-run cost summary of the current query, so the model can prioritize
 * the actually-expensive parts.
 * Returns the optimized SQL string (with one-line comment prepended).
 */
export async function optimizeSql(sql: string, ddlContext?: string, costDiagnostics?: string): Promise<string> {
  const settings = await loadVertexSettings();

  if (!settings.projectId) {
    throw new Error('Vertex AI project ID not set. Configure it in Settings → Vertex AI.');
  }
  if (!settings.model) {
    throw new Error('Vertex AI model not set. Configure it in Settings → Vertex AI.');
  }

  return callGemini(OPTIMIZATION_PROMPT(sql, ddlContext, costDiagnostics), settings);
}

// ── Structured optimization (batch optimizer) ────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface OptimizationChange {
  title:     string;
  rationale: string;
  risk:      RiskLevel;
}

export interface StructuredOptimization {
  optimizedSql: string;
  summary:      string;
  changes:      OptimizationChange[];
  overallRisk:  RiskLevel;
}

const STRUCTURED_SCHEMA = {
  type: 'OBJECT',
  properties: {
    optimizedSql: { type: 'STRING' },
    summary:      { type: 'STRING', description: 'One or two sentences on what was optimized and the expected effect.' },
    changes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title:     { type: 'STRING' },
          rationale: { type: 'STRING' },
          risk:      { type: 'STRING', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        },
        required: ['title', 'rationale', 'risk'],
      },
    },
    overallRisk: { type: 'STRING', enum: ['LOW', 'MEDIUM', 'HIGH'] },
  },
  required: ['optimizedSql', 'summary', 'changes', 'overallRisk'],
  propertyOrdering: ['summary', 'changes', 'overallRisk', 'optimizedSql'],
};

export interface StructuredOptimizeOptions {
  settings?:        VertexSettings;   // snapshot to use; loaded from storage when omitted
  ddlContext?:      string;
  costDiagnostics?: string;
  templateVars?:    Record<string, string>;
  onChunk?:         (textSoFar: string) => void;
  onRetry?:         (attempt: number, waitMs: number, reason: string) => void;
  signal?:          AbortSignal;
}

/**
 * Like optimizeSql, but asks Gemini for JSON: the SQL plus a list of changes
 * with per-change risk, streamed so callers can show live output. Used by the
 * batch optimizer, where the change list feeds the confidence report.
 */
export async function optimizeSqlStructured(sql: string, opts: StructuredOptimizeOptions = {}): Promise<StructuredOptimization> {
  const settings = opts.settings ?? await loadVertexSettings();

  if (!settings.projectId) {
    throw new Error('Vertex AI project ID not set. Configure it in Settings → Vertex AI.');
  }
  if (!settings.model) {
    throw new Error('Vertex AI model not set. Configure it in Settings → Vertex AI.');
  }

  const prompt = OPTIMIZATION_PROMPT(sql, opts.ddlContext, opts.costDiagnostics, {
    structured:   true,
    templateVars: opts.templateVars && Object.keys(opts.templateVars).length ? opts.templateVars : undefined,
  });
  const raw = await callGeminiStreamJson(prompt, STRUCTURED_SCHEMA, settings, opts.onChunk, opts.signal, opts.onRetry);

  let parsed: Partial<StructuredOptimization>;
  try {
    parsed = JSON.parse(raw) as Partial<StructuredOptimization>;
  } catch {
    throw new Error('Vertex AI returned malformed JSON.');
  }
  if (!parsed.optimizedSql?.trim()) throw new Error('Vertex AI returned no optimized SQL.');

  return {
    optimizedSql: parsed.optimizedSql.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/, '').trim(),
    summary:      parsed.summary ?? '',
    changes:      parsed.changes ?? [],
    overallRisk:  parsed.overallRisk ?? 'MEDIUM',
  };
}
