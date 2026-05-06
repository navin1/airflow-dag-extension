import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TaskNodeData } from '../types';

export const STATE_COLORS: Record<string, string> = {
  success:        '#10B981',
  failed:         '#EF4444',
  running:        '#3B82F6',
  queued:         '#F59E0B',
  up_for_retry:   '#F97316',
  skipped:        '#9CA3AF',
  upstream_failed:'#DC2626',
  deferred:       '#A855F7',
  removed:        '#6B7280',
  _default:       '#6366F1',
};

export const STATE_ICONS: Record<string, string> = {
  success:        '✓',
  failed:         '✗',
  running:        '↻',
  queued:         '◎',
  up_for_retry:   '↺',
  skipped:        '⇥',
  upstream_failed:'✗',
  deferred:       '⏸',
};

function TaskNode({ data, selected }: NodeProps) {
  const d = data as TaskNodeData;
  const color   = STATE_COLORS[d.state ?? ''] ?? STATE_COLORS._default;
  const icon    = d.state ? STATE_ICONS[d.state] ?? '◆' : null;

  return (
    <div
      style={{
        background:   color,
        border:       selected ? '2.5px solid #fff' : '2px solid rgba(255,255,255,0.25)',
        borderRadius: 10,
        padding:      '10px 14px',
        minWidth:     175,
        maxWidth:     230,
        color:        '#fff',
        fontFamily:   'Inter, system-ui, sans-serif',
        boxShadow:    selected
          ? `0 0 0 3px ${color}66, 0 4px 16px rgba(0,0,0,0.35)`
          : '0 2px 10px rgba(0,0,0,0.22)',
        cursor:       'pointer',
        transition:   'box-shadow 0.15s ease',
        userSelect:   'none',
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: 'rgba(255,255,255,0.6)', width: 8, height: 8, border: 'none' }}
      />

      {/* Task ID */}
      <div style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.3, wordBreak: 'break-word' }}>
        {d.taskId}
      </div>

      {/* Operator short name */}
      {d.operatorShort && (
        <div style={{ fontSize: 10, opacity: 0.82, marginTop: 3, fontWeight: 500 }}>
          {d.operatorShort}
        </div>
      )}

      {/* State badge */}
      {d.state && (
        <div
          style={{
            marginTop:      6,
            display:        'inline-flex',
            alignItems:     'center',
            gap:            4,
            background:     'rgba(0,0,0,0.18)',
            borderRadius:   4,
            padding:        '2px 6px',
            fontSize:       10,
            fontWeight:     600,
            letterSpacing:  '0.02em',
          }}
        >
          {icon && <span>{icon}</span>}
          <span>{d.state.replace(/_/g, ' ')}</span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: 'rgba(255,255,255,0.6)', width: 8, height: 8, border: 'none' }}
      />
    </div>
  );
}

export default memo(TaskNode);
