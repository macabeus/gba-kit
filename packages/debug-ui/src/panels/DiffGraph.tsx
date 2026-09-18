/**
 * The captures as a graph: nodes to place where they make sense, and arrows to draw
 * between any two of them.
 *
 * The query is already an edge list, so this is a second way of drawing the same thing
 * the strip draws — and the one that can say what the strip cannot, since an arrow here
 * is not obliged to join neighbours. Positions are the view's own: nothing about where a
 * node sits reaches the query, so moving one changes nothing about the answer.
 */
import type { CaptureInfo } from '@gba-kit/debug-core/protocol';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect } from 'react';

import { Screenshot } from '../components.js';
import { CIRCLED } from './DiffRows.js';

export type Relation = 'same' | 'changed' | 'increased' | 'decreased' | 'any';

export interface GraphEdge {
  from: number;
  to: number;
  relation: Relation;
}

const RELATIONS: Array<{ value: Relation; label: string }> = [
  { value: 'changed', label: '≠ changed' },
  { value: 'same', label: '= same' },
  { value: 'increased', label: '↑ up' },
  { value: 'decreased', label: '↓ down' },
  { value: 'any', label: '· anything' },
];

/** Where a capture's node sits when nothing has moved it: left to right, in capture order. */
const laidOut = (at: number): { x: number; y: number } => ({ x: at * 190, y: 0 });

const edgeId = (edge: GraphEdge): string => `${edge.from}-${edge.to}`;

type CaptureNode = Node<{ capture: CaptureInfo; at: number }, 'capture'>;

function CaptureNodeView({ data }: NodeProps<CaptureNode>) {
  const { capture, at } = data;
  return (
    <div className="gk-graph-node">
      {/* an arrow may run either way across the canvas, so both sides take one and give one */}
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Left} id="ls" />
      <Screenshot
        rgba={capture.thumbnail}
        width={capture.width}
        height={capture.height}
        label={`the screen at frame ${capture.frame}`}
      />
      <div className="gk-graph-name">
        <span className="gk-mono">{CIRCLED[at] ?? `#${at + 1}`}</span> {capture.tag || `frame ${capture.frame}`}
      </div>
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="target" position={Position.Right} id="rt" />
    </div>
  );
}

/** An arrow that says what it expects, and can be changed or dropped where it is drawn. */
function RelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const edge = data as { relation: Relation; onRelation(r: Relation): void; onDrop(): void };
  return (
    <>
      <BaseEdge id={id} path={path} />
      <EdgeLabelRenderer>
        <div
          className="gk-graph-edge-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <select
            className="gk-select"
            value={edge.relation}
            onChange={(e) => edge.onRelation(e.target.value as Relation)}
            aria-label="What the value did along this arrow"
          >
            {RELATIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button type="button" className="gk-graph-edge-drop" onClick={edge.onDrop} aria-label="Remove this arrow">
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { capture: CaptureNodeView };
const edgeTypes = { relation: RelationEdge };

export interface DiffGraphProps {
  captures: CaptureInfo[];
  edges: GraphEdge[];
  onEdges(edges: GraphEdge[]): void;
}

function Canvas({ captures, edges, onEdges }: DiffGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CaptureNode>([]);
  const { fitView } = useReactFlow();

  // a capture added or forgotten changes what there is to draw; a node already placed
  // keeps where it was put, since the position is the user's and not the data's
  useEffect(() => {
    setNodes((was) =>
      captures.map((capture, at) => {
        const held = was.find((n) => n.id === String(capture.id));
        return {
          id: String(capture.id),
          type: 'capture' as const,
          position: held?.position ?? laidOut(at),
          data: { capture, at },
        };
      }),
    );
  }, [captures, setNodes]);

  useEffect(() => {
    void fitView({ padding: 0.2, duration: 150 });
  }, [captures.length, fitView]);

  const drawn: Edge[] = edges.map((edge) => ({
    id: edgeId(edge),
    source: String(edge.from),
    target: String(edge.to),
    type: 'relation',
    animated: edge.relation === 'any',
    data: {
      relation: edge.relation,
      onRelation: (relation: Relation) =>
        onEdges(edges.map((e) => (edgeId(e) === edgeId(edge) ? { ...e, relation } : e))),
      onDrop: () => onEdges(edges.filter((e) => edgeId(e) !== edgeId(edge))),
    },
  }));

  return (
    <ReactFlow
      nodes={nodes}
      edges={drawn}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      fitView
      proOptions={{ hideAttribution: false }}
      onConnect={(connection) => {
        const from = Number(connection.source);
        const to = Number(connection.target);
        // an arrow from a capture to itself asks nothing, and a second arrow between the
        // same pair would be two answers to one question
        if (from === to || edges.some((e) => e.from === from && e.to === to)) {
          return;
        }
        onEdges([...edges, { from, to, relation: 'changed' }]);
      }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function DiffGraph(props: DiffGraphProps) {
  return (
    <div className="gk-graph">
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
