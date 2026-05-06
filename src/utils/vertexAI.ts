/**
 * Vertex AI / Gemini API client.
 * Uses a GCP service-account Bearer token from jwtAuth.ts.
 * Model, region, and project are all configurable in Settings.
 */

import { getVertexToken, loadServiceAccount } from './jwtAuth';

export interface VertexSettings {
  model:     string;
  region:    string;
  projectId: string;
}

// ── Storage helper ────────────────────────────────────────────────────────────

export async function loadVertexSettings(): Promise<VertexSettings> {
  const defaults: VertexSettings = {
    model:     'gemini-2.0-flash-001',
    region:    'us-central1',
    projectId: '',
  };

  if (typeof chrome === 'undefined' || !chrome.storage) return defaults;

  const stored = await new Promise<Record<string, string>>(r =>
    chrome.storage.sync.get(['vertexModel', 'vertexRegion', 'vertexProjectId'], v =>
      r(v as Record<string, string>),
    ),
  );

  // Fall back to project_id from the service account JSON
  let projectId = stored.vertexProjectId ?? '';
  if (!projectId) {
    const sa = await loadServiceAccount();
    projectId = sa?.project_id ?? '';
  }

  return {
    model:     stored.vertexModel     ?? defaults.model,
    region:    stored.vertexRegion    ?? defaults.region,
    projectId: projectId              || defaults.projectId,
  };
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callGemini(prompt: string, settings: VertexSettings): Promise<string> {
  const token    = await getVertexToken();
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
        maxOutputTokens: 8192,
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
You are an expert BigQuery SQL performance engineer.

Task:
1. Optimize the SQL below for BigQuery performance. Focus on:
   - Partition and cluster pruning
   - Avoiding SELECT *; select only needed columns
   - Predicate pushdown before joins
   - Replacing subqueries with CTEs where beneficial
   - Reducing bytes scanned / shuffle
2. Add EXACTLY ONE professional single-line SQL comment (-- ...) immediately above the first statement describing what the query does. Keep it concise (≤ 120 chars).

Rules:
- Return ONLY the final SQL (with the comment). No explanations, no markdown fences.
- Preserve the original query's logic and result set exactly.
- If the query is already optimal, return it as-is with only the comment added.

SQL to optimize:
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
