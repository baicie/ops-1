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
