import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background, Controls, Handle, Position, ReactFlow,
  type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useT, type MessageKey, type TranslateParams } from '../i18n';
import type { PipelineNode } from '../types';
import type { GraphEdge, GraphNode } from './ir/types';
import { Icon } from '../components/Icons';

interface PipelineNodeData extends Record<string, unknown> {
  ir: PipelineNode;
  direction: 'horizontal' | 'vertical';
}

type Translate = (key: MessageKey, params?: TranslateParams) => string;

const NODE_META: Record<string, { labelKey: MessageKey; category: string; icon: string; summary: (t: Translate, config: Record<string, unknown>) => string }> = {
  'builtin.source.http_json': { labelKey: 'studio.nodeType.httpSource', category: 'source', icon: 'activity', summary: (t, config) => config.endpoint ? String(config.endpoint) : t('studio.nodeSummary.endpointMissing') },
  'builtin.parse.json': { labelKey: 'studio.nodeType.parseJson', category: 'transform', icon: 'ops', summary: (t) => t('studio.nodeSummary.jsonParse') },
  'builtin.map.fields': { labelKey: 'studio.nodeType.mapFields', category: 'transform', icon: 'ops', summary: (t, config) => config.mappings ? t('studio.nodeSummary.mappedFields', { count: Object.keys(config.mappings as object).length }) : t('studio.nodeSummary.defaultMapping') },
  'builtin.filter.predicate': { labelKey: 'studio.nodeType.filter', category: 'transform', icon: 'filter', summary: (t, config) => config.field ? `${String(config.field)} ${String(config.op || 'eq')}` : t('studio.nodeSummary.noPredicate') },
  'builtin.validate.schema': { labelKey: 'studio.nodeType.validate', category: 'validate', icon: 'check', summary: (t) => t('studio.nodeSummary.schemaPin') },
  'builtin.sink.dataset': { labelKey: 'studio.nodeType.datasetSink', category: 'sink', icon: 'inbox', summary: (t, config) => config.datasetId ? t('studio.nodeSummary.datasetConfigured') : t('studio.nodeSummary.datasetMissing') },
};

function PipelineNodeView({ data, selected }: NodeProps<Node<PipelineNodeData>>) {
  const t = useT();
  const node = data.ir;
  const vertical = data.direction === 'vertical';
  const targetPos = vertical ? Position.Top : Position.Left;
  const sourcePos = vertical ? Position.Bottom : Position.Right;
  const meta = NODE_META[node.type];
  // An unknown type is protocol data: its last segment is the label, and the summary says so.
  const label = meta ? t(meta.labelKey) : node.type.split('.').slice(-1)[0];
  const category = meta?.category ?? 'transform';
  const icon = meta?.icon ?? 'box';
  const summary = meta ? meta.summary(t, node.config) : t('studio.nodeType.custom');
  return (
    <div className={`studio-rf-node node-${category} ${selected ? 'selected' : ''}`}>
      <div className="studio-rf-node-head">
        <span className="node-type-icon"><Icon name={icon} size={14} /></span>
        <div className="node-title"><strong>{label}</strong><small>{node.nodeId}</small></div>
      </div>
      <p className="node-summary">{summary}</p>
      <div className="studio-rf-ports">
        {node.inputs.map((port) => <span key={port.name} className="studio-rf-port input"><Handle type="target" position={targetPos} id={port.name} /><span className="port-label">{port.name}</span><span className="port-type">{port.dataType}</span></span>)}
        {node.outputs.map((port) => <span key={port.name} className="studio-rf-port output"><span className="port-label">{port.name}</span><span className="port-type">{port.dataType}</span><Handle type="source" position={sourcePos} id={port.name} /></span>)}
      </div>
    </div>
  );
}

const nodeTypes = { pipeline: PipelineNodeView };

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId?: string | null;
  onNodesChange: (nodes: GraphNode[]) => void;
  onEdgesChange: (edges: GraphEdge[]) => void;
  onConnectAttempt: (connection: Connection) => { ok: boolean; error?: string };
  onSelect: (nodeId: string | null) => void;
  layoutNonce?: number;
  direction?: 'horizontal' | 'vertical';
  viewMode?: 'readable' | 'all';
}

export function GraphCanvas({ nodes, edges, selectedId, onNodesChange, onEdgesChange, onConnectAttempt, onSelect, layoutNonce = 0, direction = 'horizontal', viewMode = 'readable' }: GraphCanvasProps) {
  const t = useT();
  const [flow, setFlow] = useState<ReactFlowInstance<Node<PipelineNodeData>, Edge> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const userMovedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!flow || !wrapRef.current) return;
    if (layoutNonce > 0) { fittedRef.current = false; userMovedRef.current = false; }
    const element = wrapRef.current;
    let frames = 0;
    const applyView = () => {
      if (viewMode === 'all') void flow.fitView({ padding: 0.2, minZoom: 0.05 });
      else flow.setViewport({ x: 14, y: 14, zoom: 0.9 });
      fittedRef.current = true;
    };
    const measureAndFit = () => {
      if (fittedRef.current) return;
      const rect = element.getBoundingClientRect();
      const nodeElements = Array.from(element.querySelectorAll('.react-flow__node'));
      const measured = nodes.length > 0 && nodeElements.length >= nodes.length
        && nodeElements.every((node) => node.getBoundingClientRect().width > 0);
      if (rect.width > 0 && rect.height > 0 && measured) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          if (!fittedRef.current) applyView();
        });
        return;
      }
      if (frames < 240) {
        frames += 1;
        rafRef.current = window.requestAnimationFrame(measureAndFit);
      }
    };
    measureAndFit();
    const observer = new ResizeObserver(() => { if (!fittedRef.current) measureAndFit(); });
    observer.observe(element);
    const onVisibility = () => { if (!document.hidden && !fittedRef.current) measureAndFit(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [flow, nodes.length, layoutNonce, viewMode, direction]);
  const flowNodes: Array<Node<PipelineNodeData>> = nodes.map((node) => ({
    id: node.id, type: 'pipeline', position: node.position,
    data: { ir: node.data.ir, direction }, selected: node.id === selectedId,
  }));
  const flowEdges: Edge[] = edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target,
    sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
    label: edge.label, animated: false,
  }));
  const handleNodesChange = useCallback((changes: any[]) => {
    const next = [...nodes];
    let changed = false;
    for (const change of changes) {
      if (change.type === 'position' && change.position && !change.dragging) {
        const index = next.findIndex((node) => node.id === change.id);
        if (index >= 0) {
          const current = next[index];
          if (current.position.x !== change.position.x || current.position.y !== change.position.y) {
            next[index] = { ...current, position: change.position };
            changed = true;
          }
        }
      }
    }
    if (changed) onNodesChange(next);
  }, [nodes, onNodesChange]);
  const connect = useCallback((connection: Connection) => {
    const result = onConnectAttempt(connection);
    if (!result.ok) return;
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target) return;
    const fromPort = source.data.ir.outputs.find((port) => port.name === connection.sourceHandle);
    const toPort = target.data.ir.inputs.find((port) => port.name === connection.targetHandle);
    if (!fromPort || !toPort) return;
    const id = `${source.id}:${fromPort.name}->${target.id}:${toPort.name}`;
    if (edges.some((edge) => edge.id === id)) return;
    onEdgesChange([...edges, {
      id, source: source.id, target: target.id, sourceHandle: fromPort.name, targetHandle: toPort.name,
      label: fromPort.dataType, data: { ir: { fromNode: source.id, fromPort: fromPort.name, toNode: target.id, toPort: toPort.name, dataType: fromPort.dataType } },
    }]);
  }, [edges, nodes, onConnectAttempt, onEdgesChange]);
  return (
    <div className="studio-rf-wrap" ref={wrapRef}>
      <ReactFlow
        style={{ width: '100%', height: '100%' }}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes as any}
        fitView={false}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        elevateEdgesOnSelect
        minZoom={0.25}
        maxZoom={1.75}
        onInit={setFlow}
        onMoveStart={() => { userMovedRef.current = true; }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodesChange={handleNodesChange}
        onConnect={connect}
        onNodesDelete={(deleted) => {
          const question = deleted.length === 1
            ? t('studio.canvas.deleteConfirm.one', { count: deleted.length })
            : t('studio.canvas.deleteConfirm.many', { count: deleted.length });
          if (!window.confirm(question)) return;
          const removed = new Set(deleted.map((item) => item.id));
          onNodesChange(nodes.filter((node) => !removed.has(node.id)));
          onEdgesChange(edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)));
        }}
        onEdgesDelete={(deleted) => onEdgesChange(edges.filter((edge) => !deleted.some((item) => item.id === edge.id)))}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
