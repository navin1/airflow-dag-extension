/**
 * The SQL optimization pipeline, shared by the single-task SQL viewer and the
 * batch optimizer:
 *
 *   dry-run original → fetch DDL + table sizes → Gemini → dry-run rewrite
 *   → (batch, SELECT only, opt-in) execute both and compare result checksums
 *
 * Every verification step is something BigQuery measured, not something the
 * model claimed — the confidence level is derived from those checks.
 */

import { optimizeSqlStructured } from './vertexAI';
import type { VertexSettings, StructuredOptimization } from './vertexAI';
import {
  extractTableRefs, fetchTableDdls, fetchTableSizes, dryRunQuery, schemasEqual,
  formatBytes, benchmarkSelect, qualifyTableRefs, executionBlocker,
} from './bigQuerySchema';
import type { DryRunResult, TableRef, BenchmarkResult } from './bigQuerySchema';
import { extractPlaceholders, renderTemplate } from './templateVars';
import type { Limiter } from './limiter';

// ── Context gathering (shared) ────────────────────────────────────────────────

export interface OptimizationContext {
  before:           DryRunResult;
  refs:             TableRef[];
  cacheHits:        number;   // schema lookups served from the in-memory cache
  schemaContext?:   string;
  costDiagnostics?: string;
}

/**
 * Dry-runs the original query (free: no execution, no bytes billed) for
 * BigQuery's own resolved table list + bytes estimate — more reliable than
 * regex-parsing FROM/JOIN — then fetches DDL and table sizes. Schema + size
 * lookups are best-effort: missing permissions shouldn't block optimization.
 */
export async function gatherContext(
  sql:      string,
  settings: VertexSettings,
  before?:  DryRunResult,   // pass an existing dry run of `sql` to skip repeating it
  jobProject?: string,      // project to run (and bill) schema lookup jobs in
): Promise<OptimizationContext> {
  before ??= await dryRunQuery(sql, settings);
  const refs = before.referencedTables.length ? before.referencedTables : extractTableRefs(sql);

  const [{ ddl, cacheHits: ddlHits }, { sizeInfo, cacheHits: metaHits }] = await Promise.all([
    fetchTableDdls(refs, settings, jobProject).catch(() => ({ ddl: '', warnings: [], cacheHits: 0 })),
    fetchTableSizes(refs, settings).catch(() => ({ sizeInfo: '', warnings: [], cacheHits: 0 })),
  ]);
  const schemaContext = [ddl, sizeInfo].filter(Boolean).join('\n\n') || undefined;
  const costDiagnostics = before.error
    ? undefined
    : `Estimated bytes scanned by the current query: ${formatBytes(before.totalBytesProcessed)} (via BigQuery dry run, tables: ${refs.map(r => `${r.project ?? settings.projectId}.${r.dataset}.${r.table}`).join(', ')}).`;

  return { before, refs, schemaContext, costDiagnostics, cacheHits: Math.min(ddlHits, metaHits) };
}

// ── Batch per-file pipeline ──────────────────────────────────────────────────

export type FileStep =
  | 'queued' | 'needs_input' | 'checking' | 'schema' | 'waiting_ai' | 'optimizing' | 'verifying'
  | 'waiting_run' | 'benchmark_original' | 'benchmark_optimized' | 'benchmark_recheck'
  | 'done' | 'failed' | 'cancelled';

export const STEP_LABELS: Record<FileStep, string> = {
  queued:              'Queued',
  needs_input:         'Needs input',
  checking:            'Checking original (dry run)',
  schema:              'Fetching schema',
  waiting_ai:          'Waiting for AI slot',
  optimizing:          'AI optimizing',
  verifying:           'Verifying rewrite (dry run)',
  waiting_run:         'Waiting for run slot',
  benchmark_original:  'Running original',
  benchmark_optimized: 'Running optimized',
  benchmark_recheck:   'Re-running original (determinism check)',
  done:                'Done',
  failed:              'Failed',
  cancelled:           'Cancelled',
};

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Check {
  status: 'pass' | 'fail' | 'warn' | 'info';
  text:   string;
}

export interface FileOptimizationResult {
  ai:                    StructuredOptimization;   // optimizedSql keeps {{ placeholders }}
  renderedSql:           string;                   // optimizedSql with the JSON variable values substituted
  statementType?:        string;
  bytesBefore:           number;
  bytesAfter:            number | null;           // null when the rewrite failed its dry run
  schemaMatch:           boolean | null;
  placeholdersPreserved: boolean;
  benchmark?:            { original: BenchmarkResult; optimized: BenchmarkResult };
  benchmarkSkipped?:     string;
  resultsMatch:          boolean | null;           // null = not executed, or inconclusive
  resultsInconclusive?:  boolean;                  // results differed, but so did two runs of the original
  confidence:            ConfidenceLevel;
  checks:                Check[];
}

export interface BenchmarkOptions {
  enabled:        boolean;
  billingProject: string;
  timeoutMs:      number;
  /** Returns a reason string if the slot-hour budget is exhausted, else null. */
  budgetBlock:    () => string | null;
  onSpend:        (slotMs: number) => void;
}

/**
 * Shared across all files in a batch: caps on concurrent Gemini calls and
 * real-run jobs, plus a gate that blocks at each stage boundary while the
 * batch is paused.
 */
export interface PipelineLimits {
  ai:    Limiter;
  bench: Limiter;
  gate:  () => Promise<void>;
}

export interface PipelineCallbacks {
  onStep:   (step: FileStep) => void;
  onLog:    (msg: string) => void;
  onStream: (textSoFar: string) => void;
}

/**
 * Optimizes one SQL template end to end. Throws on hard failures (original
 * doesn't compile, Vertex AI error, abort); verification problems with the
 * rewrite are reported via the result's checks/confidence instead.
 */
export async function optimizeFile(
  templateSql: string,
  vars:        Record<string, string>,
  settings:    VertexSettings,
  bench:       BenchmarkOptions,
  limits:      PipelineLimits,
  cb:          PipelineCallbacks,
  signal:      AbortSignal,
): Promise<FileOptimizationResult> {
  const placeholders = extractPlaceholders(templateSql);
  const usedVars = Object.fromEntries(placeholders.map(p => [p, vars[p]]));
  const rendered = renderTemplate(templateSql, vars);
  const checkAbort = async () => {
    await limits.gate();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  // 1. Original must compile — otherwise nothing downstream can be verified.
  cb.onStep('checking');
  const before = await dryRunQuery(rendered, settings);
  await checkAbort();
  if (before.error) throw new Error(`Original SQL failed BigQuery dry run: ${before.error}`);
  cb.onLog(`${before.statementType ?? 'Query'} · ${before.referencedTables.length} table(s) · ${formatBytes(before.totalBytesProcessed)} scan`);

  // 2. Schema + sizes for grounding.
  cb.onStep('schema');
  const ctx = await gatherContext(rendered, settings, before, bench.enabled && bench.billingProject ? bench.billingProject : undefined);
  await checkAbort();
  cb.onLog(ctx.schemaContext
    ? `Schema for ${ctx.refs.length} table(s) loaded${ctx.cacheHits ? ` (${ctx.cacheHits} from cache)` : ''} — DDL, partitioning, clustering, sizes`
    : 'No table schema available — continuing without it');

  // 3. Gemini (the template is sent, so placeholders survive the rewrite).
  cb.onStep('waiting_ai');
  const ai = await limits.ai.run(() => {
    cb.onStep('optimizing');
    return optimizeSqlStructured(templateSql, {
      settings,
      ddlContext:      ctx.schemaContext,
      costDiagnostics: ctx.costDiagnostics,
      templateVars:    usedVars,
      onChunk:         cb.onStream,
      onRetry:         (n, ms, why) => cb.onLog(`Vertex AI ${why} — retry ${n} in ${Math.round(ms / 1000)}s`),
      signal,
    });
  }, signal);
  await checkAbort();
  cb.onLog(`AI proposed ${ai.changes.length} change(s), overall risk ${ai.overallRisk}`);

  const checks: Check[] = [];

  // 4. Placeholders preserved?
  const optPlaceholders = extractPlaceholders(ai.optimizedSql);
  const lost  = placeholders.filter(p => !optPlaceholders.includes(p));
  const added = optPlaceholders.filter(p => !placeholders.includes(p));
  const placeholdersPreserved = lost.length === 0 && added.length === 0;
  if (placeholders.length) {
    checks.push(placeholdersPreserved
      ? { status: 'pass', text: `All ${placeholders.length} template placeholder(s) preserved` }
      : { status: 'fail', text: `Template placeholders changed${lost.length ? ` — lost: ${lost.join(', ')}` : ''}${added.length ? ` — added: ${added.join(', ')}` : ''}` });
  }

  // 5. Rewrite compiles, same statement type, same output schema?
  cb.onStep('verifying');
  const renderedOpt = renderTemplate(ai.optimizedSql, vars);
  const after = await dryRunQuery(renderedOpt, settings);
  await checkAbort();

  let schemaMatch: boolean | null = null;
  if (after.error) {
    checks.push({ status: 'fail', text: `Optimized SQL fails BigQuery dry run: ${after.error}` });
  } else {
    checks.push({ status: 'pass', text: 'Optimized SQL compiles (BigQuery dry run)' });
    if (after.statementType !== before.statementType) {
      checks.push({ status: 'fail', text: `Statement type changed: ${before.statementType} → ${after.statementType}` });
    }
    schemaMatch = schemasEqual(before.schemaFields, after.schemaFields);
    if (before.schemaFields.length || after.schemaFields.length) {
      checks.push(schemaMatch
        ? { status: 'pass', text: `Output schema identical (${before.schemaFields.length} columns, same names, types, order)` }
        : { status: 'fail', text: 'Output schema differs from the original' });
    }
    const delta = after.totalBytesProcessed - before.totalBytesProcessed;
    checks.push({
      status: delta > 0 ? 'warn' : 'info',
      text:   `Estimated scan ${formatBytes(before.totalBytesProcessed)} → ${formatBytes(after.totalBytesProcessed)}`,
    });
  }

  // 6. Real-run benchmark — SELECT only, never DML/DDL/scripts.
  let benchmark: FileOptimizationResult['benchmark'];
  let benchmarkSkipped: string | undefined;
  let resultsMatch: boolean | null = null;
  let resultsInconclusive = false;
  const verifiedSoFar = !after.error && schemaMatch !== false && after.statementType === before.statementType;

  if (!bench.enabled)                          benchmarkSkipped = 'Real-run check disabled';
  else if (executionBlocker(rendered, before)) benchmarkSkipped = executionBlocker(rendered, before)!;
  else if (executionBlocker(renderedOpt, after)) benchmarkSkipped = `optimized SQL: ${executionBlocker(renderedOpt, after)}`;
  else if (!verifiedSoFar)                     benchmarkSkipped = 'Rewrite failed static checks';
  else if (!bench.billingProject)              benchmarkSkipped = 'No billing project selected';

  if (!benchmarkSkipped) {
    const qualify = (s: string) => bench.billingProject !== settings.projectId
      ? qualifyTableRefs(s, before.referencedTables, settings.projectId)
      : s;
    const fields = before.schemaFields;

    // Original and optimized run back to back inside one limiter slot, so
    // both see similar reservation load and the slot-time comparison is fair.
    cb.onStep('waiting_run');
    await limits.bench.run(async () => {
      // Budget is checked after waiting — other files may have used it up meanwhile.
      benchmarkSkipped = bench.budgetBlock() ?? undefined;
      if (benchmarkSkipped) return;

      cb.onStep('benchmark_original');
      const orig = await benchmarkSelect(qualify(rendered), fields, bench.billingProject, settings, bench.timeoutMs, signal);
      bench.onSpend(orig.slotMs);
      if (signal.aborted) return;
      if (orig.error) {
        benchmarkSkipped = `Original failed to run: ${orig.error}`;
        return;
      }
      cb.onLog(`Original: ${(orig.slotMs / 1000).toFixed(1)} slot-s, ${orig.rowCount.toLocaleString()} rows, ${(orig.elapsedMs / 1000).toFixed(1)}s`);

      cb.onStep('benchmark_optimized');
      const opt = await benchmarkSelect(qualify(renderedOpt), fields, bench.billingProject, settings, bench.timeoutMs, signal);
      bench.onSpend(opt.slotMs);
      if (signal.aborted) return;
      if (opt.error) {
        checks.push({ status: 'fail', text: `Optimized query failed when executed: ${opt.error}` });
      } else {
        cb.onLog(`Optimized: ${(opt.slotMs / 1000).toFixed(1)} slot-s, ${opt.rowCount.toLocaleString()} rows, ${(opt.elapsedMs / 1000).toFixed(1)}s`);
        benchmark = { original: orig, optimized: opt };
        resultsMatch = orig.rowCount === opt.rowCount && orig.fingerprint === opt.fingerprint;
        const differText = `Executed both: results DIFFER (rows ${orig.rowCount.toLocaleString()} vs ${opt.rowCount.toLocaleString()}${orig.rowCount === opt.rowCount ? ', checksum mismatch' : ''})`;

        if (resultsMatch) {
          checks.push({ status: 'pass', text: `Executed both: identical results (${orig.rowCount.toLocaleString()} rows, matching checksum)` });
        } else if (bench.budgetBlock()) {
          checks.push({ status: 'fail', text: `${differText} — budget used up, so the original couldn't be re-run to rule out a non-deterministic query` });
        } else {
          // A mismatch only means something if the original is repeatable.
          // LIMIT without ORDER BY, ARRAY_AGG without ORDER BY, RAND(),
          // CURRENT_TIMESTAMP() or data landing mid-run make it vary by itself.
          cb.onStep('benchmark_recheck');
          const again = await benchmarkSelect(qualify(rendered), fields, bench.billingProject, settings, bench.timeoutMs, signal);
          bench.onSpend(again.slotMs);
          if (signal.aborted) return;
          if (!again.error && (again.rowCount !== orig.rowCount || again.fingerprint !== orig.fingerprint)) {
            resultsMatch = null;
            resultsInconclusive = true;
            checks.push({ status: 'warn', text: 'Results differ, but two runs of the ORIGINAL also differ from each other — the query is non-deterministic (e.g. LIMIT/ARRAY_AGG without ORDER BY, RAND(), CURRENT_TIMESTAMP(), or data changing), so the comparison is inconclusive. Review the diff manually.' });
          } else {
            checks.push({ status: 'fail', text: `${differText}${again.error ? '' : ' — the original is repeatable, so the difference is real'}` });
          }
        }
        if (opt.slotMs > orig.slotMs) {
          checks.push({ status: 'warn', text: 'Optimized query used more slot time than the original' });
        }
      }
    }, signal);
    await checkAbort();
  }
  if (benchmarkSkipped) checks.push({ status: 'info', text: `Not executed: ${benchmarkSkipped}` });

  // 7. Confidence — gated on measured checks, capped by the model's own risk.
  const anyFail = checks.some(c => c.status === 'fail');
  let confidence: ConfidenceLevel =
    anyFail                ? 'LOW'
    : resultsMatch === true ? 'HIGH'
    : 'MEDIUM';
  if (confidence === 'HIGH' && ai.overallRisk === 'HIGH') {
    confidence = 'MEDIUM';
    checks.push({ status: 'warn', text: 'AI flagged at least one high-risk change — capped at Medium' });
  }
  if (confidence === 'MEDIUM' && resultsMatch === null && !resultsInconclusive) {
    checks.push({ status: 'info', text: 'High confidence requires the real-run result comparison' });
  }

  return {
    ai,
    renderedSql:   renderedOpt,
    statementType: before.statementType,
    bytesBefore:   before.totalBytesProcessed,
    bytesAfter:    after.error ? null : after.totalBytesProcessed,
    schemaMatch,
    placeholdersPreserved,
    benchmark,
    benchmarkSkipped,
    resultsMatch,
    resultsInconclusive,
    confidence,
    checks,
  };
}
