import { useCallback, useState } from 'react';
import Header        from './components/Header';
import DagExplorer   from './components/DagExplorer';
import DagGraph      from './components/DagGraph';
import SettingsPanel from './components/SettingsPanel';

import { loadDag, fetchRecentRuns, fetchTaskSql, fetchTaskStates } from './utils/airflow';
import type { AirflowTask, DagMeta, DagRun } from './types';

// ── Storage helper ────────────────────────────────────────────────────────────

async function storeSqlViewerData(data: Record<string, unknown>): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise(r => chrome.storage.local.set({ sql_viewer_data: data }, r));
  }
}

function openSqlViewerTab(): void {
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.create({ url: chrome.runtime.getURL('sql-viewer.html') });
  } else {
    // Dev fallback
    window.open('/sql-viewer.html', '_blank');
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [showSettings, setShowSettings] = useState(false);

  // DAG state
  const [dagLoading, setDagLoading] = useState(false);
  const [dagError,   setDagError]   = useState<string | null>(null);
  const [dagMeta,    setDagMeta]    = useState<DagMeta | null>(null);
  const [tasks,      setTasks]      = useState<AirflowTask[]>([]);

  // Current env/dag needed for SQL fetch
  const [currentEnv, setCurrentEnv] = useState('');
  const [currentDag, setCurrentDag] = useState('');

  // Recent runs for the run selector
  const [recentRuns,    setRecentRuns]    = useState<DagRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsLoading,   setRunsLoading]   = useState(false);

  // Which task is currently having its SQL fetched (shows loading state on node)
  const [fetchingTaskId, setFetchingTaskId] = useState<string | null>(null);
  const [fetchError,     setFetchError]     = useState<string | null>(null);

  // ── Load DAG ──────────────────────────────────────────────────────────────

  const handleLoadDag = useCallback(async (envUrl: string, dagId: string) => {
    setDagLoading(true);
    setDagError(null);
    setTasks([]);
    setDagMeta(null);
    setFetchError(null);
    setRecentRuns([]);
    setSelectedRunId(null);
    setCurrentEnv(envUrl);
    setCurrentDag(dagId);
    try {
      const { meta, tasks: t } = await loadDag(envUrl, dagId);
      setDagMeta(meta);
      setTasks(t);

      // Fetch last 5 runs and default to last successful
      setRunsLoading(true);
      try {
        const runs = await fetchRecentRuns(envUrl, dagId, 5);
        setRecentRuns(runs);
        const defaultRun = runs.find(r => r.state === 'success') ?? runs[0] ?? null;
        setSelectedRunId(defaultRun?.run_id ?? null);
      } catch {
        // Non-fatal: run selector simply won't show
      } finally {
        setRunsLoading(false);
      }
    } catch (e) {
      setDagError((e as Error).message);
    } finally {
      setDagLoading(false);
    }
  }, []);

  // Re-load task states when user picks a different run
  const handleRunChange = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    try {
      const stateMap = await fetchTaskStates(currentEnv, currentDag, runId);
      setTasks(prev => prev.map(t => ({ ...t, state: stateMap.get(t.task_id) ?? null })));
    } catch {
      // Non-fatal
    }
  }, [currentEnv, currentDag]);

  // ── Task click → fetch SQL → store → open new tab ─────────────────────────

  const handleTaskClick = useCallback(async (taskId: string, operatorFull: string) => {
    if (fetchingTaskId) return; // prevent double-click while loading

    setFetchingTaskId(taskId);
    setFetchError(null);

    const t = tasks.find(x => x.task_id === taskId);
    const opShort = operatorFull
      .replace('Operator', '')
      .replace('BigQuery', 'BQ')
      .replace('Execute', 'Exec')
      .trim();

    try {
      const result = await fetchTaskSql(currentEnv, currentDag, taskId, selectedRunId);

      await storeSqlViewerData({
        taskId,
        operatorFull,
        operatorShort: opShort,
        state:         t?.state ?? null,
        dagId:         currentDag,
        dagMeta:       dagMeta
          ? {
              schedule_interval: dagMeta.schedule_interval,
              last_run_state:    dagMeta.last_run_state,
              last_run_start:    dagMeta.last_run_start,
              is_paused:         dagMeta.is_paused,
            }
          : null,
        sql:      result.sql,
        source:   result.source,
        loadedAt: new Date().toISOString(),
      });

      openSqlViewerTab();
    } catch (e) {
      setFetchError(`Failed to fetch SQL for "${taskId}": ${(e as Error).message}`);
    } finally {
      setFetchingTaskId(null);
    }
  }, [tasks, currentEnv, currentDag, dagMeta, fetchingTaskId, selectedRunId]);

  // ── Render ────────────────────────────────────────────────────────────────

  const showGraph     = tasks.length > 0;
  const showEmpty     = !dagLoading && !dagError && !showGraph;

  return (
    <div style={appStyle}>
      <Header onOpenSettings={() => setShowSettings(true)} />

      <DagExplorer
        onLoad={handleLoadDag}
        loading={dagLoading}
        dagMeta={dagMeta}
        error={dagError}
      />

      {/* ── Run selector bar ────────────────────────────────────────────── */}
      {(recentRuns.length > 0 || runsLoading) && (
        <div style={runBarStyle}>
          <span style={{ fontSize: 11, color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>
            DAG Run:
          </span>
          {runsLoading ? (
            <div style={miniSpinner} />
          ) : (
            <select
              value={selectedRunId ?? ''}
              onChange={e => handleRunChange(e.target.value)}
              style={runSelectStyle}
            >
              {recentRuns.map(r => (
                <option key={r.run_id} value={r.run_id}>
                  {RUN_STATE_PREFIX[r.state] ?? '◆'} {formatRunDate(r.execution_date)}
                  {r.state !== 'success' ? `  [${r.state}]` : ''}
                </option>
              ))}
            </select>
          )}
          <span style={{ fontSize: 10, color: '#94A3B8' }}>
            Showing task states &amp; SQL for the selected run
          </span>
        </div>
      )}

      {/* ── Task fetch status bar ───────────────────────────────────────── */}
      {(fetchingTaskId || fetchError) && (
        <div style={fetchingTaskId ? fetchingBar : errorBar}>
          {fetchingTaskId && (
            <>
              <div style={miniSpinner} />
              Fetching SQL for <strong style={{ marginLeft: 4 }}>{fetchingTaskId}</strong>…
            </>
          )}
          {fetchError && (
            <>
              ⚠ {fetchError}
              <button
                onClick={() => setFetchError(null)}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 }}
              >✕</button>
            </>
          )}
        </div>
      )}

      {/* ── Graph canvas ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {dagLoading && <LoadingOverlay message="Loading DAG structure…" />}

        {showEmpty && (
          <EmptyState message="Enter a DAG ID above and click Load DAG." />
        )}

        {showGraph && (
          <DagGraph
            tasks={tasks}
            onTaskClick={handleTaskClick}
            selectedTaskId={fetchingTaskId}
          />
        )}
      </div>

      {showGraph && !fetchingTaskId && (
        <div style={hintBar}>
          Click any task block to open its rendered SQL in a new tab.
          <span style={{ marginLeft: 8, opacity: 0.6 }}>Drag to pan · Scroll to zoom</span>
        </div>
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}

// ── Run selector helpers ──────────────────────────────────────────────────────

const RUN_STATE_PREFIX: Record<string, string> = {
  success:  '✓',
  failed:   '✗',
  running:  '↻',
  queued:   '◎',
};

function formatRunDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LoadingOverlay({ message }: { message: string }) {
  return (
    <div style={centeredStyle}>
      <div style={spinnerStyle} />
      <span style={{ color: '#64748B', fontSize: 13, marginTop: 12 }}>{message}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={centeredStyle}>
      <div style={{
        width: 56, height: 56, borderRadius: '50%', background: '#EEF2FF',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 24, marginBottom: 12,
      }}>🔍</div>
      <span style={{ color: '#64748B', fontSize: 13, textAlign: 'center', maxWidth: 320 }}>
        {message}
      </span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const appStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100vh',
  overflow: 'hidden', background: '#F0F4F8',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
};

const fetchingBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '7px 20px', background: '#EEF2FF',
  borderBottom: '1px solid #C7D2FE', fontSize: 12, color: '#3730A3', flexShrink: 0,
};

const errorBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '7px 20px', background: '#FEF2F2',
  borderBottom: '1px solid #FECACA', fontSize: 12, color: '#B91C1C', flexShrink: 0,
};

const hintBar: React.CSSProperties = {
  padding: '7px 20px', fontSize: 11, color: '#94A3B8',
  background: '#fff', borderTop: '1px solid #E2E8F0', flexShrink: 0,
};

const centeredStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  height: '100%', background: '#F0F4F8',
};

const spinnerStyle: React.CSSProperties = {
  width: 32, height: 32, border: '3px solid #E2E8F0',
  borderTop: '3px solid #6366F1', borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
};

const runBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '5px 16px', background: '#F8FAFC',
  borderBottom: '1px solid #E2E8F0', flexShrink: 0,
};

const runSelectStyle: React.CSSProperties = {
  fontSize: 12, border: '1px solid #CBD5E1', borderRadius: 6,
  padding: '3px 8px', background: '#fff', color: '#1E293B',
  cursor: 'pointer', outline: 'none', minWidth: 220,
};

const miniSpinner: React.CSSProperties = {
  width: 14, height: 14, border: '2px solid #C7D2FE',
  borderTop: '2px solid #6366F1', borderRadius: '50%',
  animation: 'spin 0.7s linear infinite', flexShrink: 0,
};
