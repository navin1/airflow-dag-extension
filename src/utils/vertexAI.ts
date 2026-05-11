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

async function callGemini(prompt: string, settings: VertexSettings): Promise<string> {
  const token = settings.authMode === 'account' ? await getToken() : await getVertexToken();
  const endpoint = `https://${settings.region}-aiplatform.googleapis.com/v1/projects/${settings.projectId}/locations/${settings.region}/publishers/google/models/${settings.model}:generateContent`;

  const resp = await fetch(endpoint, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.1,   // low temperature for deterministic SQL
        maxOutputTokens: 65536,
        topP:            0.8,
      },
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

// ── Public API ────────────────────────────────────────────────────────────────

const OPTIMIZATION_PROMPT = (sql: string) => `\
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

- Return ONLY the final documented + optimized SQL. No explanations, no markdown.
- Preserve the original query's logic and result set exactly.
- Every CTE and every top-level statement must have its annotation — no exceptions.
- If the query is already optimal, still apply full documentation (Part 1 is mandatory).

SQL:
${sql}`;

/**
 * Calls Vertex AI Gemini to optimize a BigQuery SQL query.
 * Returns the optimized SQL string (with one-line comment prepended).
 */
export async function optimizeSql(sql: string): Promise<string> {
  const settings = await loadVertexSettings();

  if (!settings.projectId) {
    throw new Error('Vertex AI project ID not set. Configure it in Settings → Vertex AI.');
  }
  if (!settings.model) {
    throw new Error('Vertex AI model not set. Configure it in Settings → Vertex AI.');
  }

  return callGemini(OPTIMIZATION_PROMPT(sql), settings);
}
