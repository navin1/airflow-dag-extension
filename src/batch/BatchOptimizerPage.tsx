/**
 * Batch SQL optimizer — opens in its own tab from the DAG viewer header.
 * Pick a folder of .sql files plus flat JSON variable files, then run every
 * selected file through the shared optimization pipeline (optimizePipeline.ts)
 * with live per-file progress, measured before/after metrics, a confidence
 * level per file, and a ZIP download of the accepted rewrites + report.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, FolderOpen, FileJson, Play, Pause, Square, Download, RefreshCw,
  CheckCircle2, XCircle, AlertTriangle, Info, ChevronLeft, X, Gauge, History,
  Hourglass, RotateCcw, Search,
} from 'lucide-react';

import DiffViewer from '../sql-viewer/DiffViewer';
import { loadVertexSettings } from '../utils/vertexAI';
import { listProjects, formatBytes, formatSlotHours } from '../utils/bigQuerySchema';
import { optimizeFile, STEP_LABELS } from '../utils/optimizePipeline';
import type { BenchmarkOptions, Check, ConfidenceLevel, FileStep, PipelineLimits } from '../utils/optimizePipeline';
import { createLimiter } from '../utils/limiter';
import {
  parseVarFile, buildVarIndex, findConflicts, resolveVars,
  extractPlaceholders, unsupportedTemplating, missingVars,
} from '../utils/templateVars';
import type { VarFile } from '../utils/templateVars';
import { DEFAULT_THEME, applyTheme, loadTheme } from '../utils/themes';
import { downloadZips } from './batchExport';
import type { BatchFile, FileRun, LogEntry } from './types';

// Files in flight = 2 × parallel, so cheap prep (dry run, schema) for the next
// files overlaps the expensive stages. Gemini calls are capped at `parallel`
// (Vertex AI quotas are per-minute) and real-run jobs at half that.
const DEFAULT_PARALLEL = 3;
const STORAGE_KEY = 'batch_last_run';

const ACTIVE_STEPS:  FileStep[] = ['checking', 'schema', 'optimizing', 'verifying', 'benchmark_original', 'benchmark_optimized', 'benchmark_recheck'];
const WAITING_STEPS: FileStep[] = ['waiting_ai', 'waiting_run'];
const IN_FLIGHT = [...ACTIVE_STEPS, ...WAITING_STEPS];
const FINAL_STEPS:  FileStep[] = ['done', 'failed', 'cancelled', 'needs_input'];

interface SavedRun {
  savedAt: number;
  folder:  string;
  files:   BatchFile[];
  runs:    Record<string, FileRun>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function hasChrome(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage;
}

async function syncGet<T extends Record<string, unknown>>(keys: string[]): Promise<Partial<T>> {
  if (!hasChrome()) return {};
  return new Promise(r => chrome.storage.sync.get(keys, v => r(v as Partial<T>)));
}

function syncSet(obj: Record<string, unknown>): void {
  if (hasChrome()) chrome.storage.sync.set(obj);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

function pctChange(before: number, after: number): number | null {
  return before ? ((after - before) / before) * 100 : null;
}

// ── Small presentational pieces ──────────────────────────────────────────────

const CONF_STYLE: Record<ConfidenceLevel, { bg: string; fg: string; label: string }> = {
  HIGH:   { bg: '#F0FDF4', fg: '#15803D', label: 'High' },
  MEDIUM: { bg: '#FFFBEB', fg: '#B45309', label: 'Medium' },
  LOW:    { bg: '#FEF2F2', fg: '#B91C1C', label: 'Low' },
};

function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  const s = CONF_STYLE[level];
  return <span style={{ ...pill, background: s.bg, color: s.fg }}>{s.label}</span>;
}

function Delta({ before, after, format }: { before: number; after: number; format: (n: number) => string }) {
  const p = pctChange(before, after);
  const better = after <= before;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: '#64748B' }}>{format(before)}</span>
      <span style={{ color: '#94A3B8' }}> → </span>
      <span style={{ fontWeight: 600, color: '#0F172A' }}>{format(after)}</span>
      {p !== null && Math.abs(p) >= 0.05 && (
        <span style={{ marginLeft: 6, fontWeight: 700, color: better ? '#15803D' : '#B91C1C' }}>
          {p > 0 ? '+' : ''}{p.toFixed(1)}%
        </span>
      )}
    </span>
  );
}

function CheckIcon({ status }: { status: Check['status'] }) {
  if (status === 'pass') return <CheckCircle2 size={14} color="#16A34A" style={{ flexShrink: 0, marginTop: 1 }} />;
  if (status === 'fail') return <XCircle size={14} color="#DC2626" style={{ flexShrink: 0, marginTop: 1 }} />;
  if (status === 'warn') return <AlertTriangle size={14} color="#D97706" style={{ flexShrink: 0, marginTop: 1 }} />;
  return <Info size={14} color="#64748B" style={{ flexShrink: 0, marginTop: 1 }} />;
}

function StepCell({ run }: { run?: FileRun }) {
  if (!run) return <span style={{ color: '#94A3B8' }}>—</span>;
  const active  = ACTIVE_STEPS.includes(run.step);
  const waiting = WAITING_STEPS.includes(run.step);
  const color =
    run.step === 'done'        ? '#15803D'
    : run.step === 'failed'    ? '#B91C1C'
    : run.step === 'needs_input' ? '#B45309'
    : active                   ? '#4F46E5'
    : waiting                  ? '#7C3AED'
    : '#64748B';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color, fontWeight: active ? 600 : 500 }}>
      {active && <RefreshCw size={12} style={{ animation: 'spin 0.8s linear infinite' }} />}
      {waiting && <Hourglass size={12} />}
      {STEP_LABELS[run.step]}
      {active && run.step !== 'benchmark_recheck' && <span style={{ color: '#94A3B8', fontWeight: 400 }}>({ACTIVE_STEPS.indexOf(run.step) + 1}/6)</span>}
    </span>
  );
}

/** Reads a JSON string value that may still be streaming in (no closing quote yet). */
function partialJsonString(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
  if (!m) return null;
  const raw = m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');   // drop a half-received escape
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

/** Turns Gemini's in-progress JSON into readable text for the live view. */
function streamPreview(text: string): { summary: string | null; changes: string[]; sql: string | null } {
  const changes = [...text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => {
    try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; }
  });
  return { summary: partialJsonString(text, 'summary'), changes, sql: partialJsonString(text, 'optimizedSql') };
}

/**
 * Number input that lets the user type freely (e.g. "0.5" via "0", ".")
 * and only clamps + commits on blur or Enter. Clamping on every keystroke
 * made intermediate values like "0" snap to the minimum.
 */
function NumberField({ value, min, max, step, integer, disabled, onCommit, style }: {
  value: number; min: number; max: number; step?: number; integer?: boolean;
  disabled?: boolean; onCommit: (n: number) => void; style?: React.CSSProperties;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);

  const commit = () => {
    let n = Number(text);
    if (!text.trim() || !Number.isFinite(n)) n = value;
    if (integer) n = Math.round(n);
    n = Math.min(max, Math.max(min, n));
    setText(String(n));
    if (n !== value) onCommit(n);
  };

  return (
    <input type="number" min={min} max={max} step={step ?? 1} value={text} disabled={disabled} style={style}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

function Section({ n, title, children, right }: { n: number; title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={stepNum}>{n}</span>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#0F172A' }}>{title}</span>
        <div style={{ marginLeft: 'auto' }}>{right}</div>
      </div>
      {children}
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BatchOptimizerPage() {
  // Inputs
  const [folder,   setFolder]   = useState('');
  const [files,    setFiles]    = useState<BatchFile[]>([]);
  const [varFiles, setVarFiles] = useState<VarFile[]>([]);
  const [choices,  setChoices]  = useState<Record<string, string>>({});

  // Real-run settings. The billing project, timeout, budget and parallelism are
  // remembered; the real-run toggle itself always starts off, because it
  // executes queries and spends slots — it must be a deliberate choice per batch.
  const [realRun,        setRealRun]        = useState(false);
  const [billingProject, setBillingProject] = useState('');
  const [projects,       setProjects]       = useState<string[]>([]);
  const [timeoutMin,     setTimeoutMin]     = useState(5);
  const [budgetHours,    setBudgetHours]    = useState(10);
  const [parallel,       setParallel]       = useState(DEFAULT_PARALLEL);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Run state
  const [phase,     setPhase]     = useState<'setup' | 'running' | 'finished'>('setup');
  const [runs,      setRuns]      = useState<Record<string, FileRun>>({});
  const [log,       setLog]       = useState<LogEntry[]>([]);
  const [paused,    setPaused]    = useState(false);
  const [spentMs,   setSpentMs]   = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt,   setEndedAt]   = useState<number | null>(null);
  const [now,       setNow]       = useState(Date.now());

  // View
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [themeKey,   setThemeKey]   = useState(DEFAULT_THEME);
  const [saved,      setSaved]      = useState<SavedRun | null>(null);
  const [notice,     setNotice]     = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [view,       setView]       = useState<'all' | 'attention' | 'done'>('all');

  const folderInput = useRef<HTMLInputElement>(null);
  const jsonInput   = useRef<HTMLInputElement>(null);
  const ctrlRef     = useRef<AbortController | null>(null);
  const pausedRef   = useRef(false);
  const spentRef    = useRef(0);
  const logEndRef   = useRef<HTMLDivElement>(null);

  // ── Mount: settings, theme, project list, previous run ────────────────────
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    loadTheme().then(t => { setThemeKey(t); applyTheme(t); });

    (async () => {
      const vs = await loadVertexSettings();
      const s = await syncGet<{ batchBillingProject: string; batchTimeoutMin: number; batchBudgetHours: number; batchParallel: number }>(
        ['batchBillingProject', 'batchTimeoutMin', 'batchBudgetHours', 'batchParallel'],
      );
      if (s.batchTimeoutMin  !== undefined) setTimeoutMin(s.batchTimeoutMin);
      if (s.batchBudgetHours !== undefined) setBudgetHours(s.batchBudgetHours);
      if (s.batchParallel    !== undefined) setParallel(s.batchParallel);
      setBillingProject(s.batchBillingProject || vs.projectId);
      setSettingsLoaded(true);
      setProjects(await listProjects(vs));
    })();

    if (hasChrome()) {
      chrome.storage.local.get([STORAGE_KEY], r => {
        const prev = r[STORAGE_KEY] as SavedRun | undefined;
        if (prev?.files?.length) setSaved(prev);
      });
    }
  }, []);

  // Only save once the stored values have been loaded — otherwise the initial
  // defaults would overwrite them on every page open.
  useEffect(() => {
    if (settingsLoaded) {
      syncSet({ batchBillingProject: billingProject, batchTimeoutMin: timeoutMin, batchBudgetHours: budgetHours, batchParallel: parallel });
    }
  }, [settingsLoaded, billingProject, timeoutMin, budgetHours, parallel]);

  // Tick the clock while running (elapsed / ETA)
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ block: 'nearest' }); }, [log.length]);

  // Save results as files finish, so closing the tab doesn't lose a long run.
  const finishedCount = Object.values(runs).filter(r => FINAL_STEPS.includes(r.step)).length;
  const acceptedKey   = Object.entries(runs).filter(([, r]) => r.accepted).map(([k]) => k).join('|');
  useEffect(() => {
    if (phase === 'setup' || !hasChrome() || finishedCount === 0) return;
    const slimRuns = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { ...r, stream: '' }]));
    const payload: SavedRun = { savedAt: Date.now(), folder, files: files.filter(f => f.selected), runs: slimRuns };
    chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
      const err = chrome.runtime.lastError;
      if (err) setNotice(`Couldn't auto-save results (${err.message}). Download the ZIPs before closing this tab.`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedCount, acceptedKey, phase]);

  // ── Derived: variables ─────────────────────────────────────────────────────
  const varIndex  = useMemo(() => buildVarIndex(varFiles), [varFiles]);
  const conflicts = useMemo(() => findConflicts(varIndex), [varIndex]);
  const vars      = useMemo(() => resolveVars(varIndex, choices), [varIndex, choices]);
  const unresolved = conflicts.filter(([k]) => !choices[k] || !varIndex.get(k)?.some(c => c.file === choices[k]));

  const missingByFile = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const f of files) m[f.path] = missingVars(f.sql, vars);
    return m;
  }, [files, vars]);

  const selected     = files.filter(f => f.selected);
  const runnable     = selected.filter(f => missingByFile[f.path].length === 0 && f.unsupported.length === 0);
  const blockedCount = selected.length - runnable.length;
  const estTokens    = Math.round(runnable.reduce((a, f) => a + f.sql.length, 0) / 4);

  // ── Input handlers ─────────────────────────────────────────────────────────
  const onFolderPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []).filter(f => /\.sql$/i.test(f.name));
    e.target.value = '';
    if (!list.length) {
      setNotice('No .sql files found in that folder.');
      return;
    }
    setNotice(null);
    const loaded: BatchFile[] = await Promise.all(list.map(async f => {
      const sql = await f.text();
      return {
        path:         f.webkitRelativePath || f.name,
        size:         f.size,
        sql,
        selected:     true,
        placeholders: extractPlaceholders(sql),
        unsupported:  unsupportedTemplating(sql),
      };
    }));
    loaded.sort((a, b) => a.path.localeCompare(b.path));
    setFolder(loaded[0].path.split('/')[0]);
    setFiles(loaded);
    setRuns({}); setLog([]); setPhase('setup'); setDetailPath(null);
  };

  const onJsonPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    const parsed = await Promise.all(list.map(async f => parseVarFile(f.name, await f.text())));
    setVarFiles(prev => [...prev.filter(p => !parsed.some(n => n.name === p.name)), ...parsed]);
  };

  const removeVarFile = (name: string) => {
    setVarFiles(prev => prev.filter(v => v.name !== name));
    setChoices(prev => Object.fromEntries(Object.entries(prev).filter(([, f]) => f !== name)));
  };

  const toggleFile = (path: string) =>
    setFiles(prev => prev.map(f => f.path === path ? { ...f, selected: !f.selected } : f));
  // All/None apply to the filtered list when a filter is active.
  const setAll = (sel: boolean) => setFiles(prev => prev.map(f =>
    !fileFilter || f.path.toLowerCase().includes(fileFilter.toLowerCase()) ? { ...f, selected: sel } : f));

  // ── Run orchestration ──────────────────────────────────────────────────────
  const updateRun = useCallback((path: string, patch: Partial<FileRun>) => {
    setRuns(prev => ({ ...prev, [path]: { ...prev[path], ...patch } }));
  }, []);

  const addLog = useCallback((msg: string, level: LogEntry['level'] = 'info', file?: string) => {
    setLog(prev => [...prev.slice(-499), { t: Date.now(), file, msg, level }]);
  }, []);

  /** Runs every selected file, or — for a retry — only `retryPaths`, keeping other results. */
  const startRun = async (retryPaths?: string[]) => {
    const targets = retryPaths ? selected.filter(f => retryPaths.includes(f.path)) : selected;
    const initial: Record<string, FileRun> = retryPaths ? { ...runs } : {};
    for (const f of targets) {
      const missing = missingByFile[f.path];
      initial[f.path] = missing.length || f.unsupported.length
        ? {
            step: 'needs_input', stream: '', accepted: false,
            missing: missing.length ? missing : undefined,
            error:   f.unsupported.length ? `Unsupported template syntax: ${f.unsupported.join(', ')}` : undefined,
          }
        : { step: 'queued', stream: '', accepted: false };
    }
    const todo = targets.filter(f => initial[f.path].step === 'queued');
    const skipped = targets.length - todo.length;

    const settings = await loadVertexSettings();
    if (!settings.projectId) {
      setNotice('Vertex AI project ID not set. Configure it in the DAG viewer under Settings → Vertex AI.');
      return;
    }

    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    pausedRef.current = false;
    spentRef.current = 0;
    setRuns(initial); setPaused(false); setSpentMs(0); setNotice(null);
    if (!retryPaths) setLog([]);
    setStartedAt(Date.now()); setEndedAt(null); setPhase('running'); setDetailPath(null);

    addLog(`${retryPaths ? 'Retrying' : 'Starting batch:'} ${todo.length} file(s)${skipped ? `, ${skipped} skipped (missing variables / unsupported syntax)` : ''} · ${parallel} parallel`);
    if (realRun) addLog(`Real-run check on — SELECT only, billed to ${billingProject}, ${timeoutMin} min timeout, ${budgetHours} slot-h budget`);

    const varsSnapshot = vars;
    const budgetMs = budgetHours * 3_600_000;
    let budgetLogged = false;
    const bench: BenchmarkOptions = {
      enabled:        realRun,
      billingProject,
      timeoutMs:      timeoutMin * 60_000,
      budgetBlock:    () => {
        if (spentRef.current < budgetMs) return null;
        if (!budgetLogged) {
          budgetLogged = true;
          addLog(`Slot-hour budget (${budgetHours} h) used up — remaining files are verified by dry run only`, 'warn');
        }
        return `slot-hour budget (${budgetHours} h) used up`;
      },
      onSpend:        ms => { spentRef.current += ms; setSpentMs(spentRef.current); },
    };
    const limits: PipelineLimits = {
      ai:    createLimiter(parallel),
      bench: createLimiter(Math.max(1, Math.ceil(parallel / 2))),
      gate:  async () => { while (pausedRef.current && !ctrl.signal.aborted) await sleep(300); },
    };

    const processFile = async (f: BatchFile) => {
      updateRun(f.path, { step: 'checking', startedAt: Date.now() });
      addLog('Started', 'info', f.path);
      // Throttle live-stream re-renders to ~5/s per file.
      let lastStream = 0;
      try {
        const result = await optimizeFile(f.sql, varsSnapshot, settings, bench, limits, {
          onStep:   step => updateRun(f.path, { step }),
          onLog:    msg  => addLog(msg, 'info', f.path),
          onStream: text => {
            const t = Date.now();
            if (t - lastStream > 200) { lastStream = t; updateRun(f.path, { stream: text }); }
          },
        }, ctrl.signal);
        updateRun(f.path, { step: 'done', result, finishedAt: Date.now(), stream: '', accepted: result.confidence !== 'LOW' });
        addLog(`Done — ${CONF_STYLE[result.confidence].label} confidence`, result.confidence === 'LOW' ? 'warn' : 'ok', f.path);
      } catch (e) {
        if (ctrl.signal.aborted) {
          updateRun(f.path, { step: 'cancelled', finishedAt: Date.now(), stream: '' });
        } else {
          const msg = (e as Error).message;
          updateRun(f.path, { step: 'failed', error: msg, finishedAt: Date.now(), stream: '' });
          addLog(msg, 'error', f.path);
        }
      }
    };

    let next = 0;
    const worker = async () => {
      for (;;) {
        await limits.gate();
        if (ctrl.signal.aborted) return;
        const f = todo[next++];
        if (!f) return;
        await processFile(f);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel * 2, todo.length) }, worker));

    if (ctrl.signal.aborted) {
      setRuns(prev => Object.fromEntries(Object.entries(prev).map(([k, r]) => [k, r.step === 'queued' ? { ...r, step: 'cancelled' as const } : r])));
      addLog('Batch cancelled', 'warn');
    } else {
      addLog('Batch complete', 'ok');
    }
    setEndedAt(Date.now());
    setPhase('finished');
  };

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    addLog(pausedRef.current ? 'Paused — each file stops at its next step; running BigQuery jobs finish first' : 'Resumed', 'warn');
  };

  const cancelRun = () => {
    ctrlRef.current?.abort();
    pausedRef.current = false;
    setPaused(false);
  };

  const restoreSaved = () => {
    if (!saved) return;
    setFolder(saved.folder);
    // Older saves stored `unsupported` as a boolean.
    setFiles(saved.files.map(f => ({ ...f, unsupported: Array.isArray(f.unsupported) ? f.unsupported : [] })));
    // Files that were queued or mid-pipeline when the tab closed come back as
    // cancelled, so they're retryable instead of spinning forever.
    setRuns(Object.fromEntries(Object.entries(saved.runs).map(([k, r]) =>
      [k, FINAL_STEPS.includes(r.step) ? r : { ...r, step: 'cancelled' as const, stream: '' }])));
    setLog([{ t: Date.now(), msg: `Restored results saved ${new Date(saved.savedAt).toLocaleString()}`, level: 'info' }]);
    setStartedAt(null); setEndedAt(null);
    setPhase('finished');
    setSaved(null);
  };

  // ── Derived: progress + summary ────────────────────────────────────────────
  const runList    = selected.map(f => runs[f.path]).filter(Boolean) as FileRun[];
  const processed  = runList.filter(r => FINAL_STEPS.includes(r.step)).length;
  const inFlight   = runList.filter(r => IN_FLIGHT.includes(r.step)).length;
  const queued     = runList.filter(r => r.step === 'queued').length;
  const durations  = runList.filter(r => r.startedAt && r.finishedAt && (r.step === 'done' || r.step === 'failed')).map(r => r.finishedAt! - r.startedAt!);
  const avgMs      = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const etaMs      = avgMs ? (avgMs * (queued + inFlight * 0.5)) / parallel : 0;
  const elapsedMs  = startedAt ? (endedAt ?? now) - startedAt : 0;

  const results    = runList.filter(r => r.result).map(r => r.result!);
  const scanned    = results.filter(r => r.bytesAfter !== null);
  const bytesBefore = scanned.reduce((a, r) => a + r.bytesBefore, 0);
  const bytesAfter  = scanned.reduce((a, r) => a + r.bytesAfter!, 0);
  const benched    = results.filter(r => r.benchmark);
  const slotBefore = benched.reduce((a, r) => a + r.benchmark!.original.slotMs, 0);
  const slotAfter  = benched.reduce((a, r) => a + r.benchmark!.optimized.slotMs, 0);
  const confCount  = (l: ConfidenceLevel) => results.filter(r => r.confidence === l).length;
  const acceptedCount = runList.filter(r => r.accepted && r.result).length;
  const retryable  = selected.filter(f => runs[f.path] && ['failed', 'cancelled'].includes(runs[f.path].step)).map(f => f.path);

  const needsAttention = (r?: FileRun) =>
    !!r && (r.step === 'failed' || r.step === 'needs_input' || r.result?.confidence === 'LOW');
  const tableRows = selected.filter(f =>
    view === 'all' ? true : view === 'done' ? runs[f.path]?.step === 'done' : needsAttention(runs[f.path]));
  const attentionCount = selected.filter(f => needsAttention(runs[f.path])).length;
  const shownFiles = fileFilter
    ? files.filter(f => f.path.toLowerCase().includes(fileFilter.toLowerCase()))
    : files;

  // Progress in the tab title (the tab is usually in the background) and a
  // leave-page warning while a batch is running.
  useEffect(() => {
    document.title = phase === 'running'
      ? `(${processed}/${runList.length}) ${paused ? 'Paused · ' : ''}Batch SQL Optimizer`
      : phase === 'finished' ? '✓ Batch SQL Optimizer' : 'Batch SQL Optimizer';
  }, [phase, processed, runList.length, paused]);
  useEffect(() => {
    if (phase !== 'running') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    // If the tab really closes, abort — which cancels running BigQuery jobs
    // (keepalive requests) instead of leaving them to burn slots until timeout.
    const abortOnClose = () => ctrlRef.current?.abort();
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', abortOnClose);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', abortOnClose);
    };
  }, [phase]);

  const canStart = settingsLoaded && phase !== 'running' && runnable.length > 0 && (!realRun || !!billingProject);
  const detailFile = detailPath ? files.find(f => f.path === detailPath) : undefined;
  const detailRun  = detailPath ? runs[detailPath] : undefined;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="batch-page" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif', background: '#F8FAFC' }}>
      <header style={headerStyle}>
        <div style={logoBox}><Layers size={16} color="#6366F1" /></div>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#0F172A' }}>Airflow DAG Viewer</span>
        <span style={{ fontWeight: 700, fontSize: 16, color: '#0F172A', marginLeft: 24 }}>Batch SQL Optimizer</span>
        {folder && <span style={{ ...pill, background: '#EEF2FF', color: '#6366F1' }}>{folder}/</span>}
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* ── Left: setup + controls ───────────────────────────────────── */}
        <aside style={sidebar}>
          {notice && (
            <div style={{ ...card, background: '#FEF2F2', borderColor: '#FECACA', display: 'flex', alignItems: 'center', gap: 8, color: '#B91C1C', fontSize: 12 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{notice}</span>
              <button style={iconBtn} onClick={() => setNotice(null)} title="Dismiss"><X size={12} /></button>
            </div>
          )}
          {saved && phase === 'setup' && (
            <div style={{ ...card, background: '#EEF2FF', borderColor: '#C7D2FE', display: 'flex', alignItems: 'center', gap: 8 }}>
              <History size={14} color="#4F46E5" />
              <span style={{ fontSize: 12, color: '#3730A3', flex: 1 }}>
                Previous run ({saved.files.length} files, {new Date(saved.savedAt).toLocaleString()})
              </span>
              <button style={linkBtn} onClick={restoreSaved}>Restore</button>
              <button style={iconBtn} onClick={() => setSaved(null)} title="Dismiss"><X size={12} /></button>
            </div>
          )}

          <Section n={1} title="SQL files" right={
            <button style={secondaryBtn} disabled={phase === 'running'} onClick={() => folderInput.current?.click()}>
              <FolderOpen size={13} /> {files.length ? 'Change folder' : 'Choose folder'}
            </button>
          }>
            <input ref={folderInput} type="file" multiple hidden onChange={onFolderPicked} />
            {!files.length ? (
              <p style={hint}>Pick a folder — every .sql file inside it (including subfolders) is listed here.</p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#64748B', marginBottom: 6 }}>
                  <span>{selected.length} of {files.length} selected</span>
                  <button style={linkBtn} disabled={phase === 'running'} onClick={() => setAll(true)}>All</button>
                  <button style={linkBtn} disabled={phase === 'running'} onClick={() => setAll(false)}>None</button>
                </div>
                {files.length > 8 && (
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <Search size={12} color="#94A3B8" style={{ position: 'absolute', left: 8, top: 8 }} />
                    <input value={fileFilter} onChange={e => setFileFilter(e.target.value)} placeholder="Filter files…"
                      style={{ ...input, width: '100%', boxSizing: 'border-box', paddingLeft: 26 }} />
                  </div>
                )}
                <div style={fileList}>
                  {shownFiles.map(f => {
                    const missing = missingByFile[f.path];
                    return (
                      <label key={f.path} style={fileRow}>
                        <input type="checkbox" checked={f.selected} disabled={phase === 'running'} onChange={() => toggleFile(f.path)} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <span style={fileName} title={f.path}>{f.path.split('/').slice(1).join('/') || f.path}</span>
                            <span style={{ color: '#94A3B8', marginLeft: 'auto', flexShrink: 0 }}>{fmtSize(f.size)}</span>
                          </div>
                          {missing.length > 0 && (
                            <div style={{ color: '#B91C1C', marginTop: 2 }}>Missing: {missing.map(m => `{{ ${m} }}`).join(', ')}</div>
                          )}
                          {f.unsupported.length > 0 && (
                            <div style={{ color: '#B91C1C', marginTop: 2 }} title={f.unsupported.join('\n')}>
                              Unsupported template syntax: {f.unsupported[0]}{f.unsupported.length > 1 ? ` (+${f.unsupported.length - 1} more)` : ''} — only {'{{ variable }}'} is supported
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                {blockedCount > 0 && (
                  <p style={{ ...hint, color: '#B91C1C' }}>
                    {blockedCount} selected file(s) have missing variables or unsupported template syntax and will be skipped.
                  </p>
                )}
              </>
            )}
          </Section>

          <Section n={2} title="Variables (JSON)" right={
            <button style={secondaryBtn} disabled={phase === 'running'} onClick={() => jsonInput.current?.click()}>
              <FileJson size={13} /> Add JSON files
            </button>
          }>
            <input ref={jsonInput} type="file" accept=".json,application/json" multiple hidden onChange={onJsonPicked} />
            {!varFiles.length && <p style={hint}>Flat JSON files ({'{"key": "value"}'}) whose values replace {'{{ key }}'} in the SQL.</p>}
            {varFiles.map(v => (
              <div key={v.name} style={{ ...fileRow, alignItems: 'flex-start' }}>
                <FileJson size={13} color="#6366F1" style={{ marginTop: 1, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={fileName}>{v.name}</span>
                  <span style={{ color: '#94A3B8', marginLeft: 6 }}>{Object.keys(v.values).length} keys</span>
                  {v.errors.map((err, i) => <div key={i} style={{ color: '#B91C1C', marginTop: 2 }}>{err}</div>)}
                </div>
                <button style={iconBtn} disabled={phase === 'running'} onClick={() => removeVarFile(v.name)} title="Remove"><X size={12} /></button>
              </div>
            ))}

            {conflicts.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: unresolved.length ? '#B91C1C' : '#15803D', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={13} />
                  {conflicts.length} key(s) defined in more than one file
                  {unresolved.length ? ` — ${unresolved.length} need a choice` : ' — all resolved'}
                </div>
                {conflicts.map(([key, cands]) => (
                  <div key={key} style={conflictBox}>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, marginBottom: 4 }}>{key}</div>
                    {cands.map(c => (
                      <label key={c.file} style={{ display: 'flex', gap: 6, alignItems: 'baseline', cursor: 'pointer', padding: '1px 0' }}>
                        <input type="radio" name={`conf-${key}`} disabled={phase === 'running'}
                          checked={choices[key] === c.file}
                          onChange={() => setChoices(prev => ({ ...prev, [key]: c.file }))} />
                        <span style={{ color: '#64748B', flexShrink: 0 }}>{c.file}:</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-all' }}>{c.value}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section n={3} title="Real-run check" right={
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={realRun} disabled={phase === 'running'} onChange={e => setRealRun(e.target.checked)} />
              Enabled
            </label>
          }>
            <p style={hint}>
              Executes the original and optimized query and compares row count + checksum of the full result —
              the strongest confidence signal. <strong>Only SELECT statements are ever executed</strong>; INSERT,
              UPDATE, DELETE, MERGE, DDL and scripts are verified by dry run only.
            </p>
            {realRun && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <label style={{ ...fieldLabel, gridColumn: '1 / -1' }}>
                  Billing project
                  <input list="batch-projects" value={billingProject} disabled={phase === 'running'}
                    onChange={e => setBillingProject(e.target.value.trim())} placeholder="my-gcp-project" style={input} />
                  <datalist id="batch-projects">{projects.map(p => <option key={p} value={p} />)}</datalist>
                </label>
                <label style={fieldLabel}>
                  Timeout per query (min)
                  <NumberField value={timeoutMin} min={1} max={360} integer disabled={phase === 'running'} onCommit={setTimeoutMin} style={input} />
                </label>
                <label style={fieldLabel}>
                  Batch budget (slot-hours)
                  <NumberField value={budgetHours} min={0.1} max={10000} step={0.5} disabled={phase === 'running'} onCommit={setBudgetHours} style={input} />
                </label>
              </div>
            )}
          </Section>

          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ ...fieldLabel, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <span title="Concurrent Gemini calls. Dry runs for upcoming files run ahead; real-run jobs use half this.">Parallel files</span>
              <NumberField value={parallel} min={1} max={8} integer disabled={phase === 'running'} onCommit={setParallel} style={{ ...input, width: 64 }} />
            </label>
            {runnable.length > 0 && phase !== 'running' && (
              <div style={{ fontSize: 11, color: '#64748B' }}>
                {runnable.length} file(s) · ~{estTokens.toLocaleString()} SQL tokens to Vertex AI (+ schema context per file)
              </div>
            )}
            {phase !== 'running' ? (
              <button style={primaryBtn(!canStart)} disabled={!canStart} onClick={() => startRun()}>
                <Play size={14} /> {phase === 'finished' ? 'Run again' : 'Optimize'} {runnable.length ? `${runnable.length} file${runnable.length > 1 ? 's' : ''}` : ''}
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ ...secondaryBtn, flex: 1, justifyContent: 'center', padding: '8px 0' }} onClick={togglePause}>
                  {paused ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
                </button>
                <button style={{ ...secondaryBtn, flex: 1, justifyContent: 'center', padding: '8px 0', color: '#B91C1C' }} onClick={cancelRun}>
                  <Square size={13} /> Cancel
                </button>
              </div>
            )}
            {phase === 'finished' && retryable.length > 0 && (
              <button style={secondaryBtn} onClick={() => startRun(retryable)}>
                <RotateCcw size={13} /> Retry {retryable.length} failed / cancelled
              </button>
            )}
            {realRun && !billingProject && phase !== 'running' && (
              <div style={{ fontSize: 11, color: '#B91C1C' }}>Choose a billing project, or turn off the real-run check.</div>
            )}
            {results.length > 0 && (
              <button style={secondaryBtn} disabled={phase === 'running'} onClick={() => downloadZips(files, runs)}
                title="Two ZIPs: one with {{ placeholders }} kept, one with JSON values substituted">
                <Download size={13} /> Download 2 ZIPs ({acceptedCount} accepted + report)
              </button>
            )}
          </div>
        </aside>

        {/* ── Right: progress, results, detail ─────────────────────────── */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {detailFile && detailRun ? (
            <FileDetail
              file={detailFile} run={detailRun} themeKey={themeKey}
              onBack={() => setDetailPath(null)}
              onToggleAccept={() => updateRun(detailFile.path, { accepted: !detailRun.accepted })}
              onRetry={phase !== 'running' && ['failed', 'cancelled'].includes(detailRun.step) ? () => startRun([detailFile.path]) : undefined}
            />
          ) : phase === 'setup' ? (
            <div style={emptyState}>
              <Gauge size={34} color="#A5B4FC" />
              <div style={{ fontSize: 15, fontWeight: 600, color: '#334155' }}>Optimize a folder of SQL files</div>
              <ol style={{ fontSize: 13, color: '#64748B', lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
                <li>Choose a folder and select the .sql files</li>
                <li>Add the JSON files holding {'{{ variable }}'} values and resolve any duplicates</li>
                <li>Optionally enable the real-run check for measured slot time and result comparison</li>
                <li>Start — every file shows live progress, then a confidence level and before/after metrics</li>
              </ol>
            </div>
          ) : (
            <>
              {/* Progress */}
              <div style={{ padding: '14px 20px', background: '#fff', borderBottom: '1px solid #E2E8F0', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, fontSize: 12, color: '#64748B', marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>
                    {phase === 'running' ? (paused ? 'Paused' : 'Optimizing…') : 'Finished'}
                  </span>
                  <span><strong style={{ color: '#0F172A' }}>{processed}</strong> / {runList.length} processed</span>
                  {inFlight > 0 && <span>{inFlight} in progress</span>}
                  {startedAt && <span>Elapsed {fmtDuration(elapsedMs)}</span>}
                  {phase === 'running' && etaMs > 0 && <span>~{fmtDuration(etaMs)} remaining</span>}
                  {realRun && (spentMs > 0 || phase === 'running') && (
                    <span style={{ marginLeft: 'auto' }}>
                      Benchmark spend {formatSlotHours(spentMs)} / {budgetHours} slot-h
                    </span>
                  )}
                </div>
                <div style={progressTrack}>
                  <div style={{ ...progressFill, width: `${runList.length ? (processed / runList.length) * 100 : 0}%` }} />
                </div>
              </div>

              {/* Summary tiles */}
              {results.length > 0 && (
                <div style={{ display: 'flex', gap: 12, padding: '12px 20px', flexShrink: 0, flexWrap: 'wrap' }}>
                  <div style={tile}>
                    <div style={tileLabel}>Estimated scan (dry run)</div>
                    <div style={tileValue}><Delta before={bytesBefore} after={bytesAfter} format={formatBytes} /></div>
                    <div style={tileSub}>{scanned.length} file(s) · on-demand bytes, informational</div>
                  </div>
                  <div style={tile}>
                    <div style={tileLabel}>Measured slot time (executed)</div>
                    <div style={tileValue}>
                      {benched.length ? <Delta before={slotBefore} after={slotAfter} format={formatSlotHours} /> : <span style={{ color: '#94A3B8' }}>—</span>}
                    </div>
                    <div style={tileSub}>{benched.length} SELECT file(s) executed</div>
                  </div>
                  <div style={tile}>
                    <div style={tileLabel}>Confidence</div>
                    <div style={{ ...tileValue, display: 'flex', gap: 10 }}>
                      <span style={{ color: CONF_STYLE.HIGH.fg }}>{confCount('HIGH')} high</span>
                      <span style={{ color: CONF_STYLE.MEDIUM.fg }}>{confCount('MEDIUM')} med</span>
                      <span style={{ color: CONF_STYLE.LOW.fg }}>{confCount('LOW')} low</span>
                    </div>
                    <div style={tileSub}>{acceptedCount} accepted for download</div>
                  </div>
                </div>
              )}

              {/* Results table */}
              <div style={{ display: 'flex', gap: 6, padding: '0 20px 8px', flexShrink: 0 }}>
                {([['all', `All (${selected.length})`], ['attention', `Needs attention (${attentionCount})`], ['done', `Done (${results.length})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setView(k)}
                    style={{ ...secondaryBtn, ...(view === k ? { background: '#EEF2FF', color: '#4338CA', borderColor: '#C7D2FE' } : {}) }}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 12px' }}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 30 }} title="Include in ZIP">✓</th>
                      <th style={th}>File</th>
                      <th style={th}>Status</th>
                      <th style={th}>Scan (dry run)</th>
                      <th style={th}>Slot time (executed)</th>
                      <th style={th}>Results</th>
                      <th style={th}>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(f => {
                      const run = runs[f.path];
                      const r = run?.result;
                      return (
                        <tr key={f.path} style={{ cursor: run ? 'pointer' : 'default', background: run && IN_FLIGHT.includes(run.step) ? '#F5F7FF' : undefined }}
                          onClick={() => run && setDetailPath(f.path)}>
                          <td style={td} onClick={e => e.stopPropagation()}>
                            <input type="checkbox" disabled={!r} checked={!!run?.accepted && !!r}
                              onChange={() => updateRun(f.path, { accepted: !run!.accepted })} />
                          </td>
                          <td style={{ ...td, fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }} title={f.path}>
                            {f.path.split('/').slice(1).join('/') || f.path}
                          </td>
                          <td style={td}>
                            <StepCell run={run} />
                            {run?.error && <div style={{ color: '#B91C1C', fontSize: 11, marginTop: 2, maxWidth: 360 }}>{run.error.slice(0, 160)}</div>}
                            {run?.missing && <div style={{ color: '#B45309', fontSize: 11, marginTop: 2 }}>Missing: {run.missing.join(', ')}</div>}
                          </td>
                          <td style={td}>{r && r.bytesAfter !== null ? <Delta before={r.bytesBefore} after={r.bytesAfter} format={formatBytes} /> : '—'}</td>
                          <td style={td}>
                            {r?.benchmark
                              ? <Delta before={r.benchmark.original.slotMs} after={r.benchmark.optimized.slotMs} format={formatSlotHours} />
                              : r ? <span style={{ color: '#94A3B8' }} title={r.benchmarkSkipped}>not executed</span> : '—'}
                          </td>
                          <td style={td}>
                            {r?.resultsMatch === true  && <span style={{ color: '#15803D', fontWeight: 600 }}>Identical</span>}
                            {r?.resultsMatch === false && <span style={{ color: '#B91C1C', fontWeight: 600 }}>Differ</span>}
                            {r?.resultsInconclusive && <span style={{ color: '#B45309', fontWeight: 600 }} title="The original query returns different results on each run">Inconclusive</span>}
                            {r && r.resultsMatch === null && !r.resultsInconclusive && <span style={{ color: '#94A3B8' }}>{r.schemaMatch ? 'Schema match' : r.schemaMatch === false ? 'Schema differs' : '—'}</span>}
                            {!r && '—'}
                          </td>
                          <td style={td}>{r ? <ConfidenceBadge level={r.confidence} /> : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Activity log */}
              <div style={logPanel}>
                {log.map((l, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: '#64748B', flexShrink: 0 }}>{new Date(l.t).toLocaleTimeString()}</span>
                    {l.file && <span style={{ color: '#A5B4FC', flexShrink: 0 }}>{l.file.split('/').pop()}</span>}
                    <span style={{ color: { info: '#CBD5E1', ok: '#4ADE80', warn: '#FBBF24', error: '#F87171' }[l.level] }}>{l.msg}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Per-file detail ───────────────────────────────────────────────────────────

function FileDetail({ file, run, themeKey, onBack, onToggleAccept, onRetry }: {
  file: BatchFile; run: FileRun; themeKey: string; onBack: () => void; onToggleAccept: () => void; onRetry?: () => void;
}) {
  const preview = useMemo(() => streamPreview(run.stream), [run.stream]);
  const r = run.result;
  const b = r?.benchmark;
  const streamRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight; }, [run.stream]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#fff', borderBottom: '1px solid #E2E8F0', flexShrink: 0 }}>
        <button style={secondaryBtn} onClick={onBack}><ChevronLeft size={13} /> Results</button>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, fontSize: 13, color: '#0F172A' }}>{file.path}</span>
        <StepCell run={run} />
        {r && <ConfidenceBadge level={r.confidence} />}
        {onRetry && (
          <button style={{ ...secondaryBtn, marginLeft: 'auto' }} onClick={onRetry}><RotateCcw size={13} /> Retry this file</button>
        )}
        {r && (
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={run.accepted} onChange={onToggleAccept} /> Include in ZIP
          </label>
        )}
      </div>

      {run.error && <div style={errorBar}><XCircle size={14} /> {run.error}</div>}

      {r && (
        <div style={{ display: 'flex', gap: 16, padding: '14px 20px', background: '#fff', borderBottom: '1px solid #E2E8F0', maxHeight: '42%', overflow: 'auto', flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {r.ai.summary && <p style={{ fontSize: 13, color: '#334155', margin: '0 0 10px', lineHeight: 1.5 }}>{r.ai.summary}</p>}
            <div style={detailHeading}>Verification</div>
            {r.checks.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#334155', padding: '2px 0', lineHeight: 1.45 }}>
                <CheckIcon status={c.status} /> <span>{c.text}</span>
              </div>
            ))}
            {b && (
              <table style={{ ...table, marginTop: 10, maxWidth: 520 }}>
                <thead><tr><th style={th}></th><th style={th}>Original</th><th style={th}>Optimized</th><th style={th}>Change</th></tr></thead>
                <tbody>
                  {([
                    ['Slot time',       b.original.slotMs,              b.optimized.slotMs,              formatSlotHours],
                    ['Bytes processed', b.original.totalBytesProcessed, b.optimized.totalBytesProcessed, formatBytes],
                    ['Elapsed',         b.original.elapsedMs,           b.optimized.elapsedMs,           (n: number) => `${(n / 1000).toFixed(1)}s`],
                  ] as const).map(([label, o, p, fmt]) => {
                    const pc = pctChange(o, p);
                    return (
                      <tr key={label}>
                        <td style={{ ...td, fontWeight: 600 }}>{label}</td>
                        <td style={td}>{fmt(o)}</td>
                        <td style={td}>{fmt(p)}</td>
                        <td style={{ ...td, fontWeight: 700, color: p <= o ? '#15803D' : '#B91C1C' }}>{pc === null ? '—' : `${pc > 0 ? '+' : ''}${pc.toFixed(1)}%`}</td>
                      </tr>
                    );
                  })}
                  <tr><td style={{ ...td, fontWeight: 600 }}>Rows</td><td style={td}>{b.original.rowCount.toLocaleString()}</td><td style={td}>{b.optimized.rowCount.toLocaleString()}</td><td style={td} /></tr>
                </tbody>
              </table>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={detailHeading}>Changes made (AI-stated · overall risk {r.ai.overallRisk})</div>
            {r.ai.changes.length === 0 && <div style={{ fontSize: 12, color: '#94A3B8' }}>No performance changes — documentation only.</div>}
            {r.ai.changes.map((c, i) => (
              <div key={i} style={{ fontSize: 12, padding: '5px 0', borderBottom: '1px solid #F1F5F9' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, color: '#0F172A' }}>{c.title}</span>
                  <span style={{ ...pill, fontSize: 10, ...(c.risk === 'LOW' ? { background: '#F0FDF4', color: '#15803D' } : c.risk === 'MEDIUM' ? { background: '#FFFBEB', color: '#B45309' } : { background: '#FEF2F2', color: '#B91C1C' }) }}>{c.risk}</span>
                </div>
                <div style={{ color: '#64748B', marginTop: 2, lineHeight: 1.45 }}>{c.rationale}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {r ? (
          <DiffViewer original={file.sql} optimized={r.ai.optimizedSql} themeKey={themeKey} />
        ) : run.stream ? (
          <pre ref={streamRef} style={streamPre}>
            {preview.summary && <><span style={{ color: '#A5B4FC' }}>-- Summary: </span>{preview.summary}{'\n'}</>}
            {preview.changes.map((c, i) => <span key={i}><span style={{ color: '#A5B4FC' }}>-- Change {i + 1}: </span>{c}{'\n'}</span>)}
            {preview.sql !== null ? <>{'\n'}{preview.sql}</> : <span style={{ color: '#64748B' }}>{'\n'}Analysing…</span>}
            <span style={{ animation: 'pulse 1s infinite' }}>▍</span>
          </pre>
        ) : (
          <pre style={{ ...streamPre, background: '#fff', color: '#334155' }}>{file.sql}</pre>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
  background: '#fff', borderBottom: '1px solid #E2E8F0', flexShrink: 0,
  boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
};

const logoBox: React.CSSProperties = {
  width: 30, height: 30, background: '#EEF2FF', borderRadius: 7,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const sidebar: React.CSSProperties = {
  width: 380, flexShrink: 0, overflowY: 'auto', padding: 14,
  display: 'flex', flexDirection: 'column', gap: 12,
  borderRight: '1px solid #E2E8F0', background: '#F1F5F9',
};

const card: React.CSSProperties = {
  background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, padding: 12,
};

const stepNum: React.CSSProperties = {
  width: 20, height: 20, borderRadius: '50%', background: '#EEF2FF', color: '#4F46E5',
  fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const hint: React.CSSProperties = { fontSize: 11.5, color: '#64748B', margin: '4px 0 0', lineHeight: 1.5 };

const fileList: React.CSSProperties = {
  maxHeight: 260, overflowY: 'auto', border: '1px solid #F1F5F9', borderRadius: 6,
};

const fileRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 8px',
  fontSize: 11.5, borderBottom: '1px solid #F1F5F9', cursor: 'pointer',
};

const fileName: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace', color: '#0F172A',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const conflictBox: React.CSSProperties = {
  fontSize: 11.5, border: '1px solid #FDE68A', background: '#FFFBEB',
  borderRadius: 6, padding: '6px 8px', marginBottom: 6,
};

const fieldLabel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#475569',
};

const input: React.CSSProperties = {
  fontSize: 12, border: '1px solid #E2E8F0', borderRadius: 6, padding: '6px 8px',
  background: '#F8FAFC', color: '#0F172A', outline: 'none', fontWeight: 400,
};

const secondaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
  color: '#475569', background: '#fff', border: '1px solid #E2E8F0',
  borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
};

const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  fontSize: 13, fontWeight: 700, padding: '9px 14px', borderRadius: 8, border: 'none',
  color:      disabled ? '#9CA3AF' : '#fff',
  background: disabled ? '#E2E8F0' : 'linear-gradient(135deg,#6366F1,#8B5CF6)',
  cursor:     disabled ? 'not-allowed' : 'pointer',
  boxShadow:  disabled ? 'none' : '0 2px 8px rgba(99,102,241,0.35)',
});

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#4F46E5', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0,
};

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', padding: 2, display: 'flex',
};

const pill: React.CSSProperties = {
  borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
};

const emptyState: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32,
};

const progressTrack: React.CSSProperties = { height: 8, background: '#E2E8F0', borderRadius: 4, overflow: 'hidden' };
const progressFill:  React.CSSProperties = {
  height: '100%', background: 'linear-gradient(90deg,#6366F1,#8B5CF6)', borderRadius: 4, transition: 'width 0.4s ease',
};

const tile: React.CSSProperties = {
  flex: '1 1 220px', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 14px',
};
const tileLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' };
const tileValue: React.CSSProperties = { fontSize: 15, marginTop: 4 };
const tileSub:   React.CSSProperties = { fontSize: 11, color: '#94A3B8', marginTop: 2 };

const table: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 12,
  border: '1px solid #E2E8F0', borderRadius: 8,
};
const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 700, color: '#64748B',
  background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', position: 'sticky', top: 0,
};
const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'top', color: '#334155' };

const logPanel: React.CSSProperties = {
  height: 170, flexShrink: 0, overflowY: 'auto', background: '#0F172A', padding: '8px 14px',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, lineHeight: 1.6,
};

const detailHeading: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 0 6px',
};

const streamPre: React.CSSProperties = {
  flex: 1, margin: 0, padding: 20, overflow: 'auto', background: '#0F172A', color: '#E2E8F0',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};

const errorBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 20px', background: '#FEF2F2',
  color: '#B91C1C', fontSize: 12, borderBottom: '1px solid #FECACA', flexShrink: 0,
};
