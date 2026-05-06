/**
 * Full-page SQL viewer — opens in a new tab when a task node is clicked.
 * Reads task + SQL data from chrome.storage.local (set by App.tsx before
 * opening the tab). Shows task metadata, formatted SQL with highlight.js,
 * and a "Optimize with Vertex AI" button that triggers side-by-side diff.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';
import {
  Copy, CheckCheck, Download, Sparkles, Layers,
  TriangleAlert, Info, RefreshCw, Palette,
} from 'lucide-react';

import DiffViewer from './DiffViewer';
import { optimizeSql } from '../utils/vertexAI';
import { STATE_COLORS, STATE_ICONS } from '../components/TaskNode';
import {
  THEMES, THEME_KEYS, DEFAULT_THEME,
  applyTheme, loadTheme, saveTheme,
} from '../utils/themes';
import type { TaskState } from '../types';

hljs.registerLanguage('sql', sql);

// ── Storage payload type ──────────────────────────────────────────────────────

interface SqlViewerData {
  taskId:       string;
  operatorFull: string;
  state:        TaskState;
  dagId:        string;
  dagMeta: {
    schedule_interval: string | null;
    last_run_state:    string | null;
    last_run_start:    string | null;
    is_paused:         boolean;
  } | null;
  sql:      string | null;
  source:   'rendered' | 'raw' | 'none';
  loadedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function highlight(code: string): string {
  try { return hljs.highlight(code, { language: 'sql' }).value; }
  catch { return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
}

function addLineNumbers(highlighted: string): string {
  return highlighted.split('\n').map((line, i) =>
    `<span class="line-num">${String(i + 1).padStart(3, ' ')}</span>${line}`
  ).join('\n');
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms    = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days  > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins  > 0) return `${mins}m ago`;
  return 'just now';
}

async function readFromStorage(): Promise<SqlViewerData | null> {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return new Promise(resolve =>
    chrome.storage.local.get(['sql_viewer_data'], r =>
      resolve((r.sql_viewer_data as SqlViewerData) ?? null),
    ),
  );
}

// ── Copy / Download buttons ───────────────────────────────────────────────────

function CopyBtn({ text, label = 'Copy', dark }: { text: string; label?: string; dark: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); };
  return (
    <button onClick={copy} style={actionBtnStyle(dark)}>
      {done ? <CheckCheck size={13} color="#4ade80" /> : <Copy size={13} />}
      <span>{done ? 'Copied!' : label}</span>
    </button>
  );
}

function DownloadBtn({ text, filename, dark }: { text: string; filename: string; dark: boolean }) {
  const dl = () => {
    const blob = new Blob([text], { type: 'text/plain' });
    const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
    a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <button onClick={dl} style={actionBtnStyle(dark)}>
      <Download size={13} /> Download .sql
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SqlViewerPage() {
  const [data,          setData]          = useState<SqlViewerData | null>(null);
  const [notFound,      setNotFound]      = useState(false);
  const [showDiff,      setShowDiff]      = useState(false);
  const [optimizedSql,  setOptimizedSql]  = useState<string | null>(null);
  const [optimizing,    setOptimizing]    = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [themeKey,      setThemeKey]      = useState(DEFAULT_THEME);

  const codeRef = useRef<HTMLElement>(null);

  const theme = THEMES[themeKey] ?? THEMES[DEFAULT_THEME];

  // Load data + theme from storage on mount
  useEffect(() => {
    readFromStorage().then(d => { if (d) setData(d); else setNotFound(true); });
    loadTheme().then(t => { setThemeKey(t); applyTheme(t); });
  }, []);

  // Re-apply theme whenever it changes
  useEffect(() => { applyTheme(themeKey); }, [themeKey]);

  // Syntax-highlight the SQL
  useEffect(() => {
    if (codeRef.current && data?.sql) {
      codeRef.current.innerHTML = addLineNumbers(highlight(data.sql));
    }
  }, [data, themeKey]);  // re-highlight when theme changes too

  const handleThemeChange = useCallback((key: string) => {
    setThemeKey(key);
    saveTheme(key);
  }, []);

  const handleOptimize = async () => {
    if (!data?.sql) return;
    setOptimizing(true); setOptimizeError(null); setShowDiff(false);
    try {
      const result = await optimizeSql(data.sql);
      setOptimizedSql(result); setShowDiff(true);
    } catch (e) {
      setOptimizeError((e as Error).message);
    } finally { setOptimizing(false); }
  };

  // ── Loading / not found ─────────────────────────────────────────────────────
  if (!data && !notFound) {
    return (
      <div style={fullCenter('#F8FAFC')}>
        <div style={spinner} /><span style={{ color: '#64748B', marginTop: 12 }}>Loading…</span>
      </div>
    );
  }
  if (notFound || !data) {
    return (
      <div style={fullCenter('#F8FAFC')}>
        <TriangleAlert size={32} color="#F59E0B" />
        <span style={{ color: '#94A3B8', marginTop: 12 }}>No SQL data found. Click a task node from the DAG viewer.</span>
      </div>
    );
  }

  const stateColor = STATE_COLORS[data.state ?? ''] ?? STATE_COLORS._default;
  const stateIcon  = data.state ? STATE_ICONS[data.state] ?? '◆' : null;
  const hasSql     = !!data.sql;
  const dark       = theme.dark;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif', background: theme.bg }}>

      {/* ── Top header (always light) ────────────────────────────────────── */}
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={logoBox}><Layers size={16} color="#6366F1" /></div>
          <span style={{ fontWeight: 700, fontSize: 13, color: '#0F172A' }}>Airflow DAG Viewer</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, paddingLeft: 24, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#0F172A' }}>{data.taskId}</span>
          <span style={tag('#EEF2FF', '#6366F1')}>{data.dagId}</span>
          {data.operatorFull && <span style={tag('#F1F5F9', '#64748B')}>{data.operatorFull.replace('Operator', '')}</span>}
          {data.state && <span style={tag(stateColor + '22', stateColor)}>{stateIcon} {data.state.replace(/_/g, ' ')}</span>}
          {data.source !== 'none' && (
            <span style={tag('#F0FDF4', '#16A34A')} title="SQL source">
              <Info size={10} style={{ verticalAlign: 'middle' }} /> {data.source}
            </span>
          )}
        </div>

        {/* Theme picker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Palette size={14} color="#6366F1" />
          <select
            value={themeKey}
            onChange={e => handleThemeChange(e.target.value)}
            style={themeSelect}
          >
            <optgroup label="── Light ──">
              {THEME_KEYS.filter(k => !THEMES[k].dark).map(k => (
                <option key={k} value={k}>{THEMES[k].label}</option>
              ))}
            </optgroup>
            <optgroup label="── Dark ──">
              {THEME_KEYS.filter(k => THEMES[k].dark).map(k => (
                <option key={k} value={k}>{THEMES[k].label}</option>
              ))}
            </optgroup>
          </select>
        </div>

        {data.dagMeta?.last_run_start && (
          <div style={{ fontSize: 11, color: '#64748B', whiteSpace: 'nowrap' }}>
            Last run: {formatDate(data.dagMeta.last_run_start)}
            <span style={{ marginLeft: 5, color: '#94A3B8' }}>({timeAgo(data.dagMeta.last_run_start)})</span>
          </div>
        )}
      </header>

      {/* ── Action bar ──────────────────────────────────────────────────── */}
      {hasSql && !showDiff && (
        <div style={{ ...actionBarStyle, background: theme.panelBg, borderBottom: `1px solid ${theme.border}` }}>
          <CopyBtn     text={data.sql!} label="Copy SQL"       dark={dark} />
          <DownloadBtn text={data.sql!} filename={`${data.taskId}.sql`} dark={dark} />
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={handleOptimize} disabled={optimizing} style={optimizeBtn(optimizing)}>
              {optimizing
                ? <><RefreshCw size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Optimizing…</>
                : <><Sparkles size={13} /> Optimize with Vertex AI</>}
            </button>
          </div>
        </div>
      )}

      {showDiff && (
        <div style={{ ...actionBarStyle, background: theme.panelBg, borderBottom: `1px solid ${theme.border}` }}>
          <button onClick={() => setShowDiff(false)} style={actionBtnStyle(dark)}>← Back to SQL</button>
          <span style={{ fontSize: 12, color: dark ? '#94A3B8' : '#64748B', marginLeft: 8 }}>
            Vertex AI optimization
          </span>
        </div>
      )}

      {/* ── Optimize error ───────────────────────────────────────────────── */}
      {optimizeError && (
        <div style={errorBar}>
          <TriangleAlert size={14} /> {optimizeError}
          <button onClick={() => setOptimizeError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#B91C1C' }}>✕</button>
        </div>
      )}

      {/* ── Content area ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: theme.bg }}>
        {!hasSql && (
          <div style={fullCenter(theme.bg)}>
            <Info size={28} color="#64748B" />
            <span style={{ color: dark ? '#94A3B8' : '#64748B', marginTop: 10, fontSize: 14 }}>
              No SQL found for <strong>{data.taskId}</strong>. This task may not use a SQL operator or has not run successfully.
            </span>
          </div>
        )}

        {hasSql && !showDiff && (
          <pre style={{ margin: 0, padding: '20px 0 40px', fontSize: 13, lineHeight: 1.7, background: 'transparent', overflow: 'auto', flex: 1 }}>
            <code ref={codeRef} className="hljs language-sql" style={{
              fontFamily: '"Courier New", "JetBrains Mono", Consolas, monospace',
              background: 'transparent', display: 'block',
              padding: '0 20px', whiteSpace: 'pre', color: theme.text,
            }} />
          </pre>
        )}

        {hasSql && showDiff && optimizedSql && (
          <DiffViewer original={data.sql!} optimized={optimizedSql} themeKey={themeKey} />
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function tag(bg: string, color: string): React.CSSProperties {
  return { background: bg, color, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' };
}

function actionBtnStyle(dark: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
    color:      dark ? '#94A3B8' : '#475569',
    background: dark ? 'rgba(255,255,255,0.07)' : '#fff',
    border:     dark ? '1px solid rgba(255,255,255,0.12)' : '1px solid #E2E8F0',
    borderRadius: 6, padding: '5px 11px', cursor: 'pointer',
  };
}

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '10px 20px',
  background: '#fff', borderBottom: '1px solid #E2E8F0',
  flexShrink: 0, gap: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
};

const logoBox: React.CSSProperties = {
  width: 30, height: 30, background: '#EEF2FF', borderRadius: 7,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const themeSelect: React.CSSProperties = {
  fontSize: 12, border: '1px solid #E2E8F0', borderRadius: 6,
  padding: '4px 8px', background: '#F8FAFC', color: '#374151',
  cursor: 'pointer', outline: 'none',
};

const actionBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 16px', flexShrink: 0,
};

const optimizeBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, fontWeight: 600,
  color:      disabled ? '#9CA3AF' : '#fff',
  background: disabled ? '#E2E8F0' : 'linear-gradient(135deg,#6366F1,#8B5CF6)',
  border: 'none', borderRadius: 7, padding: '6px 14px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  boxShadow: disabled ? 'none' : '0 2px 8px rgba(99,102,241,0.35)',
});

const errorBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 16px', background: '#FEF2F2', color: '#B91C1C',
  fontSize: 12, borderBottom: '1px solid #FECACA', flexShrink: 0,
};

const fullCenter = (bg: string): React.CSSProperties => ({
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', flex: 1, gap: 8, padding: 32, background: bg,
});

const spinner: React.CSSProperties = {
  width: 28, height: 28, border: '3px solid #E2E8F0',
  borderTop: '3px solid #6366F1', borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
};
