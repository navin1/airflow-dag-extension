/**
 * SQL Viewer — formats and syntax-highlights SQL with highlight.js.
 * Comments (-- and /* *\/) are preserved by sql-formatter and highlighted by hljs.
 */

import { useEffect, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/atom-one-dark.css';
import { Copy, CheckCheck, TriangleAlert, Info } from 'lucide-react';
import type { TaskNodeData, TaskSqlResult } from '../types';
import { STATE_COLORS, STATE_ICONS } from './TaskNode';

hljs.registerLanguage('sql', sql);

// ── Helpers ───────────────────────────────────────────────────────────────────

function highlight(sql: string): string {
  try {
    return hljs.highlight(sql, { language: 'sql' }).value;
  } catch {
    return sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function addLineNumbers(highlighted: string): string {
  const lines = highlighted.split('\n');
  return lines
    .map(
      (line, i) =>
        `<span class="line-num">${String(i + 1).padStart(3, ' ')}</span>${line}`,
    )
    .join('\n');
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days  > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins  > 0) return `${mins}m ago`;
  return 'just now';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copyFn = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copyFn} title="Copy SQL" style={copyBtnStyle}>
      {copied ? <CheckCheck size={14} color="#4ade80" /> : <Copy size={14} color="#94A3B8" />}
      <span style={{ fontSize: 11, color: copied ? '#4ade80' : '#94A3B8' }}>
        {copied ? 'Copied!' : 'Copy'}
      </span>
    </button>
  );
}

const copyBtnStyle: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  gap:            5,
  background:     'rgba(255,255,255,0.07)',
  border:         '1px solid rgba(255,255,255,0.12)',
  borderRadius:   6,
  padding:        '4px 10px',
  cursor:         'pointer',
  transition:     'background 0.15s',
};

// ── Main component ────────────────────────────────────────────────────────────

interface SqlViewerProps {
  task:         TaskNodeData | null;
  sqlResult:    TaskSqlResult | null;
  loading:      boolean;
  error:        string | null;
  lastRunStart: string | null;
  lastRunState: string | null;
  onClose:      () => void;
}

export default function SqlViewer({
  task, sqlResult, loading, error, lastRunStart, lastRunState, onClose,
}: SqlViewerProps) {
  const codeRef = useRef<HTMLElement>(null);

  const highlighted = sqlResult?.sql ? highlight(sqlResult.sql) : null;
  const withLineNums = highlighted ? addLineNumbers(highlighted) : null;

  useEffect(() => {
    if (codeRef.current && withLineNums) {
      codeRef.current.innerHTML = withLineNums;
    }
  }, [withLineNums]);

  if (!task) return null;

  const stateColor = STATE_COLORS[task.state ?? ''] ?? STATE_COLORS._default;
  const stateIcon  = task.state ? STATE_ICONS[task.state] ?? '◆' : null;

  return (
    <div style={panelStyle}>
      {/* ── Task header ─────────────────────────────────────────────────── */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          {/* Task ID */}
          <span style={{ fontWeight: 700, fontSize: 14, color: '#F1F5F9' }}>
            {task.taskId}
          </span>

          {/* Operator */}
          {task.operatorFull && (
            <span style={tagStyle('#334155')}>
              {task.operatorFull.replace('Operator', '')}
            </span>
          )}

          {/* State badge */}
          {task.state && (
            <span style={tagStyle(stateColor + '33', stateColor)}>
              {stateIcon} {task.state.replace(/_/g, ' ')}
            </span>
          )}

          {/* SQL source badge */}
          {sqlResult?.source && sqlResult.source !== 'none' && (
            <span style={tagStyle('#1e3a5f', '#60A5FA')} title="SQL comes from Jinja-rendered task instance">
              <Info size={10} style={{ verticalAlign: 'middle' }} />
              {' '}{sqlResult.source === 'rendered' ? 'rendered' : 'raw'}
            </span>
          )}

          {/* Last run info */}
          {lastRunStart && (
            <span style={{ fontSize: 11, color: '#64748B' }}>
              Last run: {formatTimestamp(lastRunStart)} ({timeAgo(lastRunStart)})
              {lastRunState && (
                <span style={{ marginLeft: 6, color: STATE_COLORS[lastRunState] ?? '#94A3B8' }}>
                  {STATE_ICONS[lastRunState] ?? ''} {lastRunState}
                </span>
              )}
            </span>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {sqlResult?.sql && <CopyButton text={sqlResult.sql} />}
          <button onClick={onClose} title="Close" style={{ ...copyBtnStyle, padding: '4px 8px' }}>
            <span style={{ fontSize: 14, color: '#94A3B8' }}>✕</span>
          </button>
        </div>
      </div>

      {/* ── Content area ────────────────────────────────────────────────── */}
      <div style={contentAreaStyle}>
        {loading && (
          <div style={centeredStyle}>
            <div style={spinnerStyle} />
            <span style={{ color: '#64748B', fontSize: 13 }}>Fetching rendered SQL…</span>
          </div>
        )}

        {!loading && error && (
          <div style={{ ...centeredStyle, flexDirection: 'column', gap: 8 }}>
            <TriangleAlert size={22} color="#F87171" />
            <span style={{ color: '#F87171', fontSize: 13, textAlign: 'center', maxWidth: 480 }}>
              {error}
            </span>
          </div>
        )}

        {!loading && !error && sqlResult?.source === 'none' && (
          <div style={{ ...centeredStyle, flexDirection: 'column', gap: 8 }}>
            <Info size={22} color="#64748B" />
            <span style={{ color: '#64748B', fontSize: 13 }}>
              No SQL found for <strong style={{ color: '#94A3B8' }}>{task.taskId}</strong>.
              This task may not use a SQL operator, or has not run successfully yet.
            </span>
          </div>
        )}

        {!loading && !error && sqlResult?.sql && (
          <pre style={preStyle}>
            {/* code element — innerHTML is set by the useEffect above */}
            <code ref={codeRef} className="hljs language-sql" style={codeStyle} />
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function tagStyle(bg: string, color = '#CBD5E1'): React.CSSProperties {
  return {
    background:   bg,
    color,
    borderRadius: 4,
    padding:      '2px 7px',
    fontSize:     11,
    fontWeight:   600,
    whiteSpace:   'nowrap',
  };
}

const panelStyle: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  background:     '#0F172A',
  borderTop:      '1px solid #1E293B',
  overflow:       'hidden',
  flex:           '0 0 45vh',
  minHeight:      180,
};

const headerStyle: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '10px 16px',
  borderBottom:   '1px solid #1E293B',
  gap:            12,
  flexShrink:     0,
};

const contentAreaStyle: React.CSSProperties = {
  flex:       1,
  overflow:   'auto',
  position:   'relative',
};

const centeredStyle: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  height:         '100%',
  gap:            10,
  padding:        24,
};

const preStyle: React.CSSProperties = {
  margin:     0,
  padding:    '16px 0 40px',  // generous bottom padding so last lines are never clipped
  fontSize:   13,
  lineHeight: 1.7,
  tabSize:    2,
  background: 'transparent',
};

const codeStyle: React.CSSProperties = {
  fontFamily:  '"Courier New", "JetBrains Mono", "Fira Code", Consolas, monospace',
  background:  'transparent',
  display:     'block',
  padding:     '0 16px',
  whiteSpace:  'pre',
};

const spinnerStyle: React.CSSProperties = {
  width:        22,
  height:       22,
  border:       '2.5px solid #1E293B',
  borderTop:    '2.5px solid #6366F1',
  borderRadius: '50%',
  animation:    'spin 0.7s linear infinite',
};
