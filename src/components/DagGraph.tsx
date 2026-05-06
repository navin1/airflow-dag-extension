import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  BackgroundVariant,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';

import TaskNode, { STATE_COLORS } from './TaskNode';
import type { AirflowTask, TaskNodeData } from '../types';

// ── Dagre layout ──────────────────────────────────────────────────────────────

const NODE_WIDTH  = 210;
const NODE_HEIGHT =  90;

function layoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 110, marginx: 50, marginy: 50 });

  nodes.forEach(n => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach(e => g.setEdge(e.source, e.target));

  Dagre.layout(g);

  return nodes.map(n => {
    const { x, y } = g.node(n.id);
    return { ...n, position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 } };
  });
}

// ── Build ReactFlow nodes/edges from Airflow task list ────────────────────────

function buildGraph(tasks: AirflowTask[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = tasks.map(t => {
    const opShort = t.operator
      .replace('Operator', '')
      .replace('BigQuery', 'BQ')
      .replace('Execute', 'Exec')
      .trim();

    const data: TaskNodeData = {
      taskId:          t.task_id,
      operatorFull:    t.operator,
      operatorShort:   opShort,
      state:           t.state ?? null,
      durationSeconds: t.duration_seconds,
    };

    return {
      id:       t.task_id,
      type:     'taskNode',
      position: { x: 0, y: 0 }, // overwritten by dagre
      data,
    };
  });

  const edges: Edge[] = [];
  tasks.forEach(t => {
    t.downstream_task_ids.forEach(dsId => {
      edges.push({
        id:           `e_${t.task_id}__${dsId}`,
        source:       t.task_id,
        target:       dsId,
        type:         'smoothstep',
        animated:     t.state === 'running',
        style:        { stroke: '#94A3B8', strokeWidth: 1.8 },
        markerEnd:    { type: MarkerType.ArrowClosed, color: '#94A3B8', width: 14, height: 14 },
      });
    });
  });

  return { nodes, edges };
}

// ── Component ─────────────────────────────────────────────────────────────────

const nodeTypes = { taskNode: TaskNode };

interface DagGraphProps {
  tasks: AirflowTask[];
  onTaskClick: (taskId: string, operatorFull: string) => void;
  selectedTaskId: string | null;
}

export default function DagGraph({ tasks, onTaskClick, selectedTaskId }: DagGraphProps) {
  const { nodes: rawNodes, edges: rawEdges } = useMemo(() => buildGraph(tasks), [tasks]);
  const layouted = useMemo(() => layoutNodes(rawNodes, rawEdges), [rawNodes, rawEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layouted);
  const [edges, , onEdgesChange]         = useEdgesState(rawEdges);

  // Update selected highlight without re-running layout
  useEffect(() => {
    setNodes(prev =>
      prev.map(n => ({ ...n, selected: n.id === selectedTaskId })),
    );
  }, [selectedTaskId, setNodes]);

  // Re-run layout only when the set of tasks changes (add/remove nodes)
  useEffect(() => {
    setNodes(layouted);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouted.length]);

  // Update node data (state colours) whenever task states change — no layout re-run
  useEffect(() => {
    if (!tasks.length) return;
    const stateMap = new Map(tasks.map(t => [t.task_id, t.state ?? null]));
    setNodes(prev => prev.map(n => ({
      ...n,
      data: { ...(n.data as TaskNodeData), state: stateMap.get(n.id) ?? null },
    })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const d = node.data as TaskNodeData;
      onTaskClick(d.taskId, d.operatorFull);
    },
    [onTaskClick],
  );

  const miniMapColor = useCallback(
    (node: Node) => {
      const d = node.data as TaskNodeData;
      return STATE_COLORS[d.state ?? ''] ?? STATE_COLORS._default;
    },
    [],
  );

  if (!tasks.length) return null;

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#CBD5E1" />
        <Controls style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8 }} />
        <MiniMap
          nodeColor={miniMapColor}
          style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8 }}
          maskColor="rgba(241,245,249,0.7)"
        />
      </ReactFlow>
    </div>
  );
}
