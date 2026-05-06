import { useEffect, useState } from 'react';
import { Search, RefreshCw, Pause, Play, CalendarClock } from 'lucide-react';
import type { DagMeta, EnvConfig } from '../types';
import { STATE_COLORS } from './TaskNode';

// ── Chrome storage helper ──────────────────────────────────────────────────────

async function getEnvs(): Promise<EnvConfig[]> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise(resolve =>
      chrome.storage.sync.get(['envs'], r => resolve((r.envs as EnvConfig[]) ?? [])),
    );
  }
  try {
    const s = JSON.parse(localStorage.getItem('adv_settings') ?? '{}');
    return s.envs ?? [];
  } catch {
    return [];
  }
}

function formatSchedule(s: string | null): string {
  if (!s || s === 'None' || s === 'null') return 'no schedule';
  // Common cron → human
  const map: Record<string, string> = {
    '@daily':   'daily',
    '@hourly':  'hourly',
    '@weekly':  'weekly',
    '@monthly': 'monthly',
  };
  return map[s] ?? s;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface DagExplorerProps {
  onLoad:    (envUrl: string, dagId: string) => void;
  loading:   boolean;
  dagMeta:   DagMeta | null;
  error:     string | null;
}

export default function DagExplorer({ onLoad, loading, dagMeta, error }: DagExplorerProps) {
  const [envs,        setEnvs]        = useState<EnvConfig[]>([]);
  const [selectedEnv, setSelectedEnv] = useState('');
  const [dagId,       setDagId]       = useState('');

  useEffect(() => {
    getEnvs().then(list => {
      setEnvs(list);
      if (list.length > 0 && !selectedEnv) setSelectedEnv(list[0].url);
    });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedEnv && dagId.trim()) onLoad(selectedEnv, dagId.trim());
  };

  const stateColor = dagMeta?.last_run_state
    ? STATE_COLORS[dagMeta.last_run_state] ?? '#94A3B8'
    : '#94A3B8';

  return (
    <div style={wrapStyle}>
      {/* ── Controls row ──────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} style={formStyle}>
        {/* Environment dropdown */}
        {envs.length > 0 ? (
          <select
            value={selectedEnv}
            onChange={e => setSelectedEnv(e.target.value)}
            style={selectStyle}
            disabled={loading}
          >
            {envs.map(env => (
              <option key={env.url} value={env.url}>{env.name}</option>
            ))}
          </select>
        ) : (
          <div style={noEnvBadge}>
            No environments — open Settings
          </div>
        )}

        {/* DAG ID input */}
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={searchIcon} />
          <input
            value={dagId}
            onChange={e => setDagId(e.target.value)}
            placeholder="Enter DAG ID…"
            style={{ ...inputStyle, paddingLeft: 30 }}
            disabled={loading || envs.length === 0}
          />
        </div>

        {/* Load button */}
        <button
          type="submit"
          disabled={loading || !dagId.trim() || !selectedEnv}
          style={loadBtn(loading || !dagId.trim() || !selectedEnv)}
        >
          {loading
            ? <><RefreshCw size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</>
            : <><Search size={13} /> Load DAG</>}
        </button>
      </form>

      {/* ── DAG meta bar ──────────────────────────────────────────────── */}
      {error && (
        <div style={errorBar}>{error}</div>
      )}

      {!error && dagMeta && (
        <div style={metaBar}>
          <div style={metaPill}>
            <CalendarClock size={12} />
            <span>{formatSchedule(dagMeta.schedule_interval)}</span>
          </div>

          {dagMeta.is_paused ? (
            <div style={metaPill}><Pause size={12} /><span>paused</span></div>
          ) : (
            <div style={metaPill}><Play size={12} /><span>active</span></div>
          )}

          {dagMeta.last_run_start && (
            <div style={{ ...metaPill, color: stateColor }}>
              <span
                style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                  background: stateColor, flexShrink: 0,
                }}
              />
              <span>Last run: {formatDate(dagMeta.last_run_start)}</span>
              {dagMeta.last_run_state && (
                <span style={{ fontWeight: 600 }}>({dagMeta.last_run_state})</span>
              )}
            </div>
          )}

          {!dagMeta.last_success_run_id && (
            <div style={{ ...metaPill, color: '#F59E0B' }}>
              ⚠ No successful run — SQL may not be available
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const wrapStyle: React.CSSProperties = {
  flexShrink: 0,
  background: '#F8FAFC',
  borderBottom: '1px solid #E2E8F0',
};

const formStyle: React.CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  gap:        10,
  padding:    '10px 20px',
};

const selectStyle: React.CSSProperties = {
  padding:      '7px 10px',
  fontSize:     13,
  border:       '1px solid #E2E8F0',
  borderRadius: 7,
  outline:      'none',
  background:   '#fff',
  color:        '#0F172A',
  fontFamily:   'Inter, system-ui, sans-serif',
  minWidth:     140,
  maxWidth:     200,
  cursor:       'pointer',
};

const inputStyle: React.CSSProperties = {
  width:        '100%',
  padding:      '7px 10px',
  fontSize:     13,
  border:       '1px solid #E2E8F0',
  borderRadius: 7,
  outline:      'none',
  fontFamily:   'Inter, system-ui, sans-serif',
  boxSizing:    'border-box',
};

const searchIcon: React.CSSProperties = {
  position:  'absolute',
  left:      9,
  top:       '50%',
  transform: 'translateY(-50%)',
  color:     '#94A3B8',
  pointerEvents: 'none',
};

const loadBtn = (disabled: boolean): React.CSSProperties => ({
  display:      'flex',
  alignItems:   'center',
  gap:          6,
  padding:      '7px 16px',
  background:   disabled ? '#E2E8F0' : '#6366F1',
  color:        disabled ? '#9CA3AF' : '#fff',
  border:       'none',
  borderRadius: 7,
  fontSize:     13,
  fontWeight:   600,
  cursor:       disabled ? 'not-allowed' : 'pointer',
  whiteSpace:   'nowrap',
  transition:   'background 0.15s',
});

const metaBar: React.CSSProperties = {
  display:     'flex',
  alignItems:  'center',
  flexWrap:    'wrap',
  gap:         8,
  padding:     '6px 20px 10px',
};

const metaPill: React.CSSProperties = {
  display:      'inline-flex',
  alignItems:   'center',
  gap:          5,
  fontSize:     11,
  color:        '#64748B',
  background:   '#fff',
  border:       '1px solid #E2E8F0',
  borderRadius: 20,
  padding:      '3px 9px',
};

const errorBar: React.CSSProperties = {
  background:   '#FEF2F2',
  color:        '#B91C1C',
  fontSize:     12,
  padding:      '8px 20px',
  borderTop:    '1px solid #FECACA',
};

const noEnvBadge: React.CSSProperties = {
  fontSize:     12,
  color:        '#F59E0B',
  background:   '#FFFBEB',
  border:       '1px solid #FDE68A',
  borderRadius: 7,
  padding:      '7px 12px',
};
