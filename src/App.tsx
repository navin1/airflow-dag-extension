import { useCallback, useState } from 'react';
import Header       from './components/Header';
import DagExplorer  from './components/DagExplorer';
import DagGraph     from './components/DagGraph';
import SqlViewer    from './components/SqlViewer';
import SettingsPanel from './components/SettingsPanel';

import { loadDag, fetchTaskSql } from './utils/airflow';
import type { AirflowTask, DagMeta, TaskNodeData, TaskSqlResult } from './types';

export default function App() {
  // ── UI state ────────────────────────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false);

  // ── DAG state ───────────────────────────────────────────────────────────────
  const [dagLoading, setDagLoading]     = useState(false);
  const [dagError,   setDagError]       = useState<string | null>(null);
  const [dagMeta,    setDagMeta]        = useState<DagMeta | null>(null);
  const [tasks,      setTasks]          = useState<AirflowTask[]>([]);

  // Current environment/DAG (needed when fetching SQL on click)
  const [currentEnv, setCurrentEnv]     = useState<string>('');
  const [currentDag, setCurrentDag]     = useState<string>('');

  // ── SQL panel state ─────────────────────────────────────────────────────────
  const [selectedTask,  setSelectedTask]  = useState<TaskNodeData | null>(null);
  const [sqlResult,     setSqlResult]     = useState<TaskSqlResult | null>(null);
  const [sqlLoading,    setSqlLoading]    = useState(false);
  const [sqlError,      setSqlError]      = useState<string | null>(null);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleLoadDag = useCallback(async (envUrl: string, dagId: string) => {
    setDagLoading(true);
    setDagError(null);
    setTasks([]);
    setDagMeta(null);
    setSelectedTask(null);
    setSqlResult(null);
    setSqlError(null);
    setCurrentEnv(envUrl);
    setCurrentDag(dagId);
    try {
      const { meta, tasks: t } = await loadDag(envUrl, dagId);
      setDagMeta(meta);
      setTasks(t);
    } catch (e) {
      setDagError((e as Error).message);
    } finally {
      setDagLoading(false);
    }
  }, []);

  const handleTaskClick = useCallback(async (taskId: string, operatorFull: string) => {
    // Build TaskNodeData from the tasks list
    const t = tasks.find(x => x.task_id === taskId);
    if (!t) return;

    const opShort = operatorFull
      .replace('Operator', '')
      .replace('BigQuery', 'BQ')
      .replace('Execute', 'Exec')
      .trim();

    setSelectedTask({
      taskId,
      operatorFull,
      operatorShort: opShort,
      state:         t.state ?? null,
    });
    setSqlResult(null);
    setSqlError(null);
    setSqlLoading(true);

    try {
      const result = await fetchTaskSql(currentEnv, currentDag, taskId);
      setSqlResult(result);
    } catch (e) {
      setSqlError((e as Error).message);
    } finally {
      setSqlLoading(false);
    }
  }, [tasks, currentEnv, currentDag]);

  const handleClosePanel = useCallback(() => {
    setSelectedTask(null);
    setSqlResult(null);
    setSqlError(null);
  }, []);

  // ── Empty state helper ───────────────────────────────────────────────────────

  const showEmptyGraph = !dagLoading && !dagError && tasks.length === 0;
  const showGraph      = tasks.length > 0;
  const panelOpen      = !!selectedTask;

  return (
    <div style={appStyle}>
      <Header onOpenSettings={() => setShowSettings(true)} />

      <DagExplorer
        onLoad={handleLoadDag}
        loading={dagLoading}
        dagMeta={dagMeta}
        error={dagError}
      />

      {/* ── Main canvas area ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Graph */}
        <div style={{
          flex:       panelOpen ? '0 0 55%' : '1',
          minHeight:  120,
          overflow:   'hidden',
          transition: 'flex 0.25s ease',
        }}>
          {dagLoading && <LoadingOverlay message="Loading DAG structure…" />}

          {showEmptyGraph && (
            <EmptyState
              hasError={false}
              message="Enter a DAG ID above and click Load DAG."
            />
          )}

          {showGraph && (
            <DagGraph
              tasks={tasks}
              onTaskClick={handleTaskClick}
              selectedTaskId={selectedTask?.taskId ?? null}
            />
          )}
        </div>

        {/* SQL panel */}
        {panelOpen && (
          <SqlViewer
            task={selectedTask}
            sqlResult={sqlResult}
            loading={sqlLoading}
            error={sqlError}
            lastRunStart={dagMeta?.last_run_start ?? null}
            lastRunState={dagMeta?.last_run_state ?? null}
            onClose={handleClosePanel}
          />
        )}

        {/* Hint bar */}
        {showGraph && !panelOpen && (
          <div style={hintBar}>
            Click any task block to inspect its rendered SQL.
            <span style={{ marginLeft: 8, opacity: 0.6 }}>
              Drag to pan · Scroll to zoom · Fit View in controls
            </span>
          </div>
        )}
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LoadingOverlay({ message }: { message: string }) {
  return (
    <div style={overlayStyle}>
      <div style={spinner} />
      <span style={{ color: '#64748B', fontSize: 13, marginTop: 12 }}>{message}</span>
    </div>
  );
}

function EmptyState({ message }: { hasError: boolean; message: string }) {
  return (
    <div style={overlayStyle}>
      <div style={{
        width:        60,
        height:       60,
        borderRadius: '50%',
        background:   '#EEF2FF',
        display:      'flex',
        alignItems:   'center',
        justifyContent:'center',
        fontSize:     26,
        marginBottom: 12,
      }}>
        🔍
      </div>
      <span style={{ color: '#64748B', fontSize: 13, textAlign: 'center', maxWidth: 320 }}>
        {message}
      </span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const appStyle: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  height:         '100vh',
  overflow:       'hidden',
  background:     '#F0F4F8',
  fontFamily:     'Inter, system-ui, -apple-system, sans-serif',
};

const overlayStyle: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  alignItems:     'center',
  justifyContent: 'center',
  height:         '100%',
  background:     '#F0F4F8',
};

const spinner: React.CSSProperties = {
  width:        32,
  height:       32,
  border:       '3px solid #E2E8F0',
  borderTop:    '3px solid #6366F1',
  borderRadius: '50%',
  animation:    'spin 0.7s linear infinite',
};

const hintBar: React.CSSProperties = {
  padding:      '7px 20px',
  fontSize:     11,
  color:        '#94A3B8',
  background:   '#fff',
  borderTop:    '1px solid #E2E8F0',
  flexShrink:   0,
};
