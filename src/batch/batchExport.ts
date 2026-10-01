/**
 * Builds the two downloadable ZIPs for a batch run — identical except for the
 * SQL flavour:
 *   *-templated.zip → optimized/<path> with {{ placeholders }} intact (for Airflow)
 *   *-rendered.zip  → optimized/<path> with JSON variable values substituted
 * Each also carries report.csv (one row per file) and REPORT.md (summary +
 * per-file checks and changes).
 */

import { zipSync, strToU8 } from 'fflate';
import { formatBytes, formatSlotHours } from '../utils/bigQuerySchema';
import { STEP_LABELS } from '../utils/optimizePipeline';
import type { BatchFile, FileRun } from './types';

function pct(before: number, after: number): string {
  if (!before) return '';
  const p = ((before - after) / before) * 100;
  return `${p >= 0 ? '-' : '+'}${Math.abs(p).toFixed(1)}%`;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(files: BatchFile[], runs: Record<string, FileRun>): string {
  const header = [
    'file', 'status', 'accepted', 'confidence', 'statement_type',
    'bytes_before', 'bytes_after', 'bytes_change',
    'slot_ms_before', 'slot_ms_after', 'slot_change',
    'elapsed_ms_before', 'elapsed_ms_after', 'results_match', 'ai_risk', 'error',
  ];
  const rows = files.filter(f => f.selected).map(f => {
    const run = runs[f.path];
    const r = run?.result;
    const b = r?.benchmark;
    return [
      f.path,
      run ? STEP_LABELS[run.step] : 'Not run',
      run?.accepted ? 'yes' : 'no',
      r?.confidence ?? '',
      r?.statementType ?? '',
      r?.bytesBefore ?? '',
      r?.bytesAfter ?? '',
      r && r.bytesAfter !== null ? pct(r.bytesBefore, r.bytesAfter) : '',
      b?.original.slotMs ?? '',
      b?.optimized.slotMs ?? '',
      b ? pct(b.original.slotMs, b.optimized.slotMs) : '',
      b?.original.elapsedMs ?? '',
      b?.optimized.elapsedMs ?? '',
      r?.resultsInconclusive ? 'inconclusive' : r?.resultsMatch === null || r?.resultsMatch === undefined ? 'not run' : r.resultsMatch ? 'yes' : 'NO',
      r?.ai.overallRisk ?? '',
      run?.error ?? (run?.missing?.length ? `missing variables: ${run.missing.join(' ')}` : ''),
    ].map(csvCell).join(',');
  });
  return [header.join(','), ...rows].join('\n') + '\n';
}

function buildMarkdown(files: BatchFile[], runs: Record<string, FileRun>): string {
  const sel  = files.filter(f => f.selected);
  const done = sel.filter(f => runs[f.path]?.result);
  const sum = (fn: (r: FileRun) => number) => done.reduce((a, f) => a + fn(runs[f.path]), 0);
  const scanned = done.filter(f => runs[f.path].result!.bytesAfter !== null);
  const bytesBefore = scanned.reduce((a, f) => a + runs[f.path].result!.bytesBefore, 0);
  const bytesAfter  = scanned.reduce((a, f) => a + runs[f.path].result!.bytesAfter!, 0);
  const benched = done.filter(f => runs[f.path].result!.benchmark);
  const slotBefore = benched.reduce((a, f) => a + runs[f.path].result!.benchmark!.original.slotMs, 0);
  const slotAfter  = benched.reduce((a, f) => a + runs[f.path].result!.benchmark!.optimized.slotMs, 0);

  const lines: string[] = [
    '# SQL Optimization Report',
    '',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '## Summary',
    '',
    `- Files optimized: ${done.length} of ${sel.length} selected`,
    `- Accepted into this ZIP: ${done.filter(f => runs[f.path].accepted).length}`,
    `- Confidence: ${sum(r => +(r.result!.confidence === 'HIGH'))} high · ${sum(r => +(r.result!.confidence === 'MEDIUM'))} medium · ${sum(r => +(r.result!.confidence === 'LOW'))} low`,
    `- Estimated scan (dry run, ${scanned.length} files): ${formatBytes(bytesBefore)} → ${formatBytes(bytesAfter)} (${pct(bytesBefore, bytesAfter) || 'n/a'})`,
    benched.length
      ? `- Measured slot time (executed, ${benched.length} files): ${formatSlotHours(slotBefore)} → ${formatSlotHours(slotAfter)} (${pct(slotBefore, slotAfter) || 'n/a'})`
      : '- Measured slot time: no files were executed',
    '',
    '## Files',
  ];

  for (const f of sel) {
    const run = runs[f.path];
    lines.push('', `### ${f.path}`, '');
    if (!run) { lines.push('Not run.'); continue; }
    if (!run.result) {
      lines.push(`Status: ${STEP_LABELS[run.step]}${run.error ? ` — ${run.error}` : ''}${run.missing?.length ? ` — missing variables: ${run.missing.join(', ')}` : ''}`);
      continue;
    }
    const r = run.result;
    lines.push(
      `**Confidence: ${r.confidence}** · AI risk: ${r.ai.overallRisk} · ${run.accepted ? 'accepted' : 'not accepted'}`,
      '',
      r.ai.summary,
      '',
      '**Checks**',
      '',
      ...r.checks.map(c => `- ${{ pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' }[c.status]} ${c.text}`),
    );
    if (r.benchmark) {
      const { original: o, optimized: p } = r.benchmark;
      lines.push(
        '',
        '| | Original | Optimized | Change |',
        '|---|---|---|---|',
        `| Slot time | ${formatSlotHours(o.slotMs)} | ${formatSlotHours(p.slotMs)} | ${pct(o.slotMs, p.slotMs)} |`,
        `| Bytes processed | ${formatBytes(o.totalBytesProcessed)} | ${formatBytes(p.totalBytesProcessed)} | ${pct(o.totalBytesProcessed, p.totalBytesProcessed)} |`,
        `| Elapsed | ${(o.elapsedMs / 1000).toFixed(1)}s | ${(p.elapsedMs / 1000).toFixed(1)}s | ${pct(o.elapsedMs, p.elapsedMs)} |`,
        `| Rows | ${o.rowCount.toLocaleString()} | ${p.rowCount.toLocaleString()} | |`,
      );
    }
    if (r.ai.changes.length) {
      lines.push('', '**Changes**', '');
      for (const c of r.ai.changes) lines.push(`- **${c.title}** (${c.risk} risk) — ${c.rationale}`);
    }
  }
  return lines.join('\n') + '\n';
}

export type SqlFlavour = 'templated' | 'rendered';

export function buildZip(files: BatchFile[], runs: Record<string, FileRun>, flavour: SqlFlavour): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'report.csv': strToU8(buildCsv(files, runs)),
    'REPORT.md':  strToU8(buildMarkdown(files, runs)),
  };
  for (const f of files) {
    const run = runs[f.path];
    if (!f.selected || !run?.accepted || !run.result) continue;
    const sql = flavour === 'templated' ? run.result.ai.optimizedSql : run.result.renderedSql;
    entries[`optimized/${f.path}`] = strToU8(sql + '\n');
  }
  return zipSync(entries, { level: 6 });
}

/** Downloads both ZIPs (templated + rendered) in one click. */
export function downloadZips(files: BatchFile[], runs: Record<string, FileRun>): void {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  (['templated', 'rendered'] as const).forEach((flavour, i) => {
    const blob = new Blob([buildZip(files, runs, flavour) as BlobPart], { type: 'application/zip' });
    const a = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: `sql-optimization-${stamp}-${flavour}.zip`,
    });
    // Stagger so Chrome doesn't drop the second download as a duplicate gesture
    setTimeout(() => { a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }, i * 300);
  });
}
