import type { PipelineDefinition, PipelineEdge, PipelineNode } from '../../types';

export interface GraphNodeData {
  ir: PipelineNode;
}

export interface GraphNode {
  id: string;
  type: 'pipeline';
  position: { x: number; y: number };
  data: GraphNodeData;
  selected?: boolean;
  /**
   * The node's rendered size, reported by React Flow after it measures the DOM.
   *
   * It is part of the model rather than canvas-internal state because this component is
   * controlled: React Flow renders a node `visibility: hidden` until `measured` has both a width
   * and a height, and the only path by which that measurement reaches the node is the `dimensions`
   * change being written back here. Omitting it left nodes invisible from mount until some
   * unrelated re-measure - see the handler in GraphCanvas.tsx.
   */
  measured?: { width: number; height: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  data: { ir: PipelineEdge };
  selected?: boolean;
}

export interface StudioGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface StudioIssue {
  code: string;
  message: string;
  nodeId?: string;
  port?: string;
}

export interface StudioValidation {
  valid: boolean;
  errors: StudioIssue[];
  warnings: StudioIssue[];
}

export interface StudioSource {
  definition: PipelineDefinition;
  revision: number;
}
