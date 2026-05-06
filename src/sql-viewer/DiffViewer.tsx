/**
 * Side-by-side SQL diff viewer.
 * Left  = original SQL  (removed lines highlighted red)
 * Right = optimized SQL (added lines highlighted green)
 * Unchanged lines are aligned and shown in both panels.
 *
 * Each line is individually syntax-highlighted with highlight.js
 * so diff colours and SQL colours coexist cleanly.
 */

import { useMemo } from 'react';
import { diffLines } from 'diff';
import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github.css';
import { Copy, Download } from 'lucide-react';

hljs.registerLanguage('sql', sql);

// ── Types ─────────────────────────────────────────────────────────────────────

type LineType = 'normal' | 'removed' | 'added' | 'empty';

interface SideLine {
  text: string;
  type: LineType;
}

interface DiffRow {
  left:  SideLine;
  right: SideLine;
  num:   number;
}

// ── Diff builder ──────────────────────────────────────────────────────────────

function splitLines(val: string): string[] {
  const lines = val.split('\n');
  // Remove trailing empty element that split() adds for trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildRows(original: string, optimized: string): DiffRow[] {
  const changes = diffLines(original, optimized);
  const rows: DiffRow[] = [];
  let num = 0;

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    const lines  = splitLines(change.value);

    if (!change.added && !change.removed) {
      // Unchanged — show in both columns
      lines.forEach(line => {
        rows.push({
          left:  { text: line, type: 'normal' },
          right: { text: line, type: 'normal' },
          num:   ++num,
        });
      });
      i++;
    } else if (change.removed) {
      // Pair with the immediately following added block (if any)
      const next        = changes[i + 1];
      const removedLines = lines;
      const addedLines   = next?.added ? splitLines(next.value) : [];
      const maxLen       = Math.max(removedLines.length, addedLines.length);

      for (let j = 0; j < maxLen; j++) {
        const hasLeft  = j < removedLines.length;
        const hasRight = j < addedLines.length;
        rows.push({
          left:  { text: hasLeft  ? removedLines[j] : '', type: hasLeft  ? 'removed' : 'empty' },
          right: { text: hasRight ? addedLines[j]   : '', type: hasRight ? 'added'   : 'empty' },
          num:   ++num,
        });
      }
      i += next?.added ? 2 : 1;
    } else {
      // Added with no preceding removed block
      lines.forEach(line => {
        rows.push({
          left:  { text: '',   type: 'empty' },
          right: { text: line, type: 'added' },
          num:   ++num,
        });
      });
      i++;
    }
  }
  return rows;
}

// ── Syntax highlight a single line ────────────────────────────────────────────

function hl(line: string): string {
  if (!line.trim()) return '&nbsp;';
  try {
    return hljs.highlight(line, { language: 'sql' }).value;
  } catch {
    return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

// ── Line background colours ───────────────────────────────────────────────────

const BG: Record<LineType, string> = {
  normal:  'transparent',
  removed: '#FFF0F0',
  added:   '#F0FFF8',
  empty:   '#FAFAFA',
};

const BORDER_LEFT: Record<LineType, string> = {
  normal:  '3px solid transparent',
  removed: '3px solid #EF4444',
  added:   '3px solid #10B981',
  empty:   '3px solid transparent',
};

// ── Action buttons ────────────────────────────────────────────────────────────

function ActionBar({ sql, label }: { sql: string; label: string }) {
  const copy = async () => { await navigator.clipboard.writeText(sql); };
  const download = () => {
    const blob = new Blob([sql], { type: 'text/plain' });
    const a    = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: `${label.toLowerCase().replace(/\s+/g, '_')}.sql`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div style={actionBarStyle}>
      <span style={{ fontWeight: 700, fontSize: 12, color: '#94A3B8', letterSpacing: '0.06em' }}>
        {label.toUpperCase()}
      </span>
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button onClick={copy}     style={actionBtn} title={`Copy ${label}`}>
          <Copy size={12} /> Copy
        </button>
        <button onClick={download} style={actionBtn} title={`Download ${label}`}>
          <Download size={12} /> .sql
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface DiffViewerProps {
  original:  string;
  optimized: string;
}

export default function DiffViewer({ original, optimized }: DiffViewerProps) {
  const rows = useMemo(() => buildRows(original, optimized), [original, optimized]);

  const addedCount   = rows.filter(r => r.right.type === 'added').length;
  const removedCount = rows.filter(r => r.left.type  === 'removed').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Diff stats */}
      <div style={statsBar}>
        <span style={{ color: '#10B981', fontWeight: 600, fontSize: 12 }}>+{addedCount} added</span>
        <span style={{ color: '#EF4444', fontWeight: 600, fontSize: 12 }}>−{removedCount} removed</span>
        <span style={{ color: '#64748B', fontSize: 11 }}>
          {rows.length} total lines · line-by-line diff
        </span>
      </div>

      {/* Side-by-side panels */}
      <div style={diffContainer}>
        {/* LEFT — original */}
        <div style={panelStyle}>
          <ActionBar sql={original}  label="Original SQL" />
          <div style={codeArea}>
            {rows.map((row, i) => (
              <div
                key={i}
                style={{
                  display:        'flex',
                  background:     BG[row.left.type],
                  borderLeft:     BORDER_LEFT[row.left.type],
                  minHeight:      '1.7em',
                  alignItems:     'baseline',
                }}
              >
                <span style={lineNumStyle}>{row.left.type !== 'empty' ? row.num : ''}</span>
                <span
                  style={codeLineStyle}
                  dangerouslySetInnerHTML={{ __html: hl(row.left.text) }}
                />
              </div>
            ))}
          </div>
        </div>

        <div style={divider} />

        {/* RIGHT — optimized */}
        <div style={panelStyle}>
          <ActionBar sql={optimized} label="Optimized SQL" />
          <div style={codeArea}>
            {rows.map((row, i) => (
              <div
                key={i}
                style={{
                  display:    'flex',
                  background: BG[row.right.type],
                  borderLeft: BORDER_LEFT[row.right.type],
                  minHeight:  '1.7em',
                  alignItems: 'baseline',
                }}
              >
                <span style={lineNumStyle}>{row.right.type !== 'empty' ? row.num : ''}</span>
                <span
                  style={codeLineStyle}
                  dangerouslySetInnerHTML={{ __html: hl(row.right.text) }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const statsBar: React.CSSProperties = {
  display:      'flex',
  gap:          16,
  padding:      '8px 20px',
  background:   '#F8FAFC',
  borderBottom: '1px solid #E2E8F0',
  alignItems:   'center',
  flexShrink:   0,
};

const diffContainer: React.CSSProperties = {
  display:  'flex',
  flex:     1,
  overflow: 'hidden',
};

const panelStyle: React.CSSProperties = {
  flex:          1,
  display:       'flex',
  flexDirection: 'column',
  overflow:      'hidden',
  background:    '#FFFFFF',
};

const divider: React.CSSProperties = {
  width:      2,
  background: '#E2E8F0',
  flexShrink: 0,
};

const actionBarStyle: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  padding:      '8px 12px',
  background:   '#F8FAFC',
  borderBottom: '1px solid #E2E8F0',
  gap:          8,
  flexShrink:   0,
};

const actionBtn: React.CSSProperties = {
  display:      'inline-flex',
  alignItems:   'center',
  gap:          4,
  fontSize:     11,
  color:        '#475569',
  background:   '#fff',
  border:       '1px solid #E2E8F0',
  borderRadius: 5,
  padding:      '3px 8px',
  cursor:       'pointer',
};

const codeArea: React.CSSProperties = {
  flex:          1,
  overflow:      'auto',
  paddingBottom: 40,
};

const lineNumStyle: React.CSSProperties = {
  display:    'inline-block',
  minWidth:   '3em',
  color:      '#CBD5E1',
  fontSize:   12,
  fontFamily: '"Courier New", monospace',
  padding:    '0 8px',
  userSelect: 'none',
  flexShrink: 0,
  textAlign:  'right',
  lineHeight: '1.7em',
  borderRight: '1px solid #F1F5F9',
};

const codeLineStyle: React.CSSProperties = {
  fontFamily: '"Courier New", "JetBrains Mono", Consolas, monospace',
  fontSize:   13,
  lineHeight: '1.7em',
  whiteSpace: 'pre',
  flex:       1,
  padding:    '0 12px 0 8px',
  color:      '#1E293B',
};
