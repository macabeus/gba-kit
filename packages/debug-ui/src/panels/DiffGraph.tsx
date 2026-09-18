/**
 * The captures as a graph, which is what the query already is: nodes are the captures,
 * arrows are the edges, and an arrow may join any two of them rather than only
 * neighbours. That is what the picture is for — a repeat is drawn where it happened
 * instead of chosen out of a list.
 *
 * Where a node sits says one thing and one thing only: the order the captures are read
 * in, left to right, which is the order of the value columns under it. Nothing else about
 * a position reaches the query.
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
import { useEffect, useState } from 'react';

import { Menu, Screenshot } from '../components.js';
import { CIRCLED } from './DiffRows.js';

export type Relation = 'same' | 'changed' | 'increased' | 'decreased' | 'any';

/** One arrow: what the value did between two captures. */
export interface GraphEdge {
  from: number;
  to: number;
  relation: Relation;
}

/** Every relation an arrow can carry: how it is picked, and how it reads in a sentence. */
export const RELATIONS: Array<{ value: Relation; sign: string; label: string; word: string }> = [
  { value: 'changed', sign: '≠', label: '≠ changed', word: 'changed' },
  { value: 'same', sign: '=', label: '= same', word: 'stayed the same' },
  { value: 'increased', sign: '↑', label: '↑ went up', word: 'went up' },
  { value: 'decreased', sign: '↓', label: '↓ went down', word: 'went down' },
  { value: 'any', sign: '·', label: '· anything', word: 'did anything' },
];

const RELATION_SIGN = new Map(RELATIONS.map((r) => [r.value, r.sign]));

export const RELATION_WORD = new Map(RELATIONS.map((r) => [r.value, r.word]));

/** What a new arrow says until it is told otherwise; "what changed here" is why one gets drawn. */
export const DEFAULT_RELATION: Relation = 'changed';

/**
 * A node's handles. An arrow leaves the side its target is on and arrives on the side it
 * came from, so a link forward reads left to right and one back to an earlier capture
 * curves outside the nodes rather than across them — which is also what keeps its label
 * off the node in front.
 */
const HANDLES = { sourceRight: 'sr', sourceLeft: 'sl', targetLeft: 'tl', targetRight: 'tr' } as const;

/**
 * Which sides an arrow between two nodes leaves and arrives on. Left to the first handle
 * that matches and every arrow starts on a node's left, which puts its label behind the
 * node before it.
 */
export function edgeHandles(fromX: number, toX: number): { sourceHandle: string; targetHandle: string } {
  return fromX <= toX
    ? { sourceHandle: HANDLES.sourceRight, targetHandle: HANDLES.targetLeft }
    : { sourceHandle: HANDLES.sourceLeft, targetHandle: HANDLES.targetRight };
}

/** Where a capture's node sits when nothing has moved it: a row, in capture order. */
const laidOut = (at: number): { x: number; y: number } => ({ x: at * 260, y: 0 });

const edgeId = (edge: GraphEdge): string => `${edge.from}->${edge.to}`;

interface CaptureNodeData {
  capture: CaptureInfo;
  at: number;
  value: string;
  busy: boolean;
  onName(name: string): void;
  onValue(text: string): void;
  onForget(): void;
  [key: string]: unknown;
}

export type CaptureNode = Node<CaptureNodeData, 'capture'>;

function CaptureNodeView({ data }: NodeProps<CaptureNode>) {
  const { capture, at, value, busy, onName, onValue, onForget } = data;
  const [naming, setNaming] = useState(false);
  // a value is the rare thing to say about a capture, so its field arrives when it is
  // asked for and the node stays the size of what it actually carries
  const [valuing, setValuing] = useState(false);
  const shown = value !== '' || valuing;
  const name = capture.tag || `frame ${capture.frame}`;
  return (
    <div className="gk-graph-node">
      <Handle type="target" position={Position.Left} id={HANDLES.targetLeft} />
      <Handle type="source" position={Position.Left} id={HANDLES.sourceLeft} />
      <Screenshot
        rgba={capture.thumbnail}
        width={capture.width}
        height={capture.height}
        label={`the screen at frame ${capture.frame}`}
      />
      <div className="gk-graph-row">
        <span className="gk-mono gk-small">{CIRCLED[at] ?? `#${at + 1}`}</span>
        {naming ? (
          <input
            className="gk-input nodrag"
            autoFocus
            defaultValue={capture.tag}
            placeholder={`frame ${capture.frame}`}
            aria-label={`Name capture ${at + 1}`}
            onBlur={(e) => {
              setNaming(false);
              if (e.currentTarget.value.trim() !== capture.tag) {
                onName(e.currentTarget.value.trim());
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.currentTarget.value = capture.tag;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className={`gk-graph-title${capture.tag ? '' : ' gk-muted'}`} title={name}>
            {name}
          </span>
        )}
        <Menu
          className="nodrag"
          label={`What to do with capture ${at + 1}`}
          disabled={busy}
          items={[
            { label: 'Rename', onSelect: () => setNaming(true) },
            shown
              ? { label: 'Forget the value it held', onSelect: () => (onValue(''), setValuing(false)) }
              : { label: 'Say a value it held', onSelect: () => setValuing(true) },
            { label: 'Forget this capture', onSelect: onForget },
          ]}
        />
      </div>
      {shown && (
        <input
          className="gk-input nodrag"
          autoFocus={valuing && value === ''}
          placeholder="a value it held"
          aria-label={`The value capture ${at + 1} held`}
          value={value}
          onChange={(e) => onValue(e.target.value)}
        />
      )}
      <Handle type="source" position={Position.Right} id={HANDLES.sourceRight} />
      <Handle type="target" position={Position.Right} id={HANDLES.targetRight} />
    </div>
  );
}

interface RelationEdgeData {
  relation: Relation;
  onRelation(relation: Relation): void;
  onDrop(): void;
  [key: string]: unknown;
}

/** An arrow that says what it expects, and is changed or dropped where it is drawn. */
function RelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const { relation, onRelation, onDrop } = data as unknown as RelationEdgeData;
  return (
    <>
      <BaseEdge id={id} path={path} />
      <EdgeLabelRenderer>
        <div
          className="gk-graph-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {/* a control wide enough to read the relation in is wider than the gap between
              two nodes, so the sign is what is drawn and the words are in the menu */}
          <Menu
            label={`This arrow: ${RELATIONS.find((r) => r.value === relation)?.word ?? relation}`}
            trigger={<span className="gk-graph-sign">{RELATION_SIGN.get(relation)}</span>}
            items={[
              ...RELATIONS.map((r) => ({ label: r.label, onSelect: () => onRelation(r.value) })),
              { label: 'Remove this arrow', onSelect: onDrop },
            ]}
          />
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
  /** an exact value a capture held, as typed, keyed by capture id */
  values: Record<number, string>;
  busy: boolean;
  onEdges(edges: GraphEdge[]): void;
  onName(id: number, name: string): void;
  onValue(id: number, text: string): void;
  onForget(id: number): void;
  /** the captures in the order the canvas now reads them, left to right */
  onOrder(ids: number[]): void;
}

function Canvas({ captures, edges, values, busy, onEdges, onName, onValue, onForget, onOrder }: DiffGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CaptureNode>([]);
  const { fitView } = useReactFlow();

  // a capture added or forgotten changes what there is to draw; a node already placed
  // keeps where it was put, since a position is the user's and not the data's
  useEffect(() => {
    setNodes((was) =>
      captures.map((capture, at) => ({
        id: String(capture.id),
        type: 'capture' as const,
        position: was.find((n) => n.id === String(capture.id))?.position ?? laidOut(at),
        data: {
          capture,
          at,
          value: values[capture.id] ?? '',
          busy,
          onName: (name: string) => onName(capture.id, name),
          onValue: (text: string) => onValue(capture.id, text),
          onForget: () => onForget(capture.id),
        },
      })),
    );
  }, [captures, values, busy, onName, onValue, onForget, setNodes]);

  useEffect(() => {
    void fitView({ padding: 0.15, duration: 150 });
  }, [captures.length, fitView]);

  const xOf = (id: number): number => nodes.find((n) => n.id === String(id))?.position.x ?? 0;

  const drawn: Edge[] = edges.map((edge) => {
    return {
      id: edgeId(edge),
      source: String(edge.from),
      target: String(edge.to),
      ...edgeHandles(xOf(edge.from), xOf(edge.to)),
      type: 'relation',
      data: {
        relation: edge.relation,
        onRelation: (relation: Relation) =>
          onEdges(edges.map((e) => (edgeId(e) === edgeId(edge) ? { ...e, relation } : e))),
        onDrop: () => onEdges(edges.filter((e) => edgeId(e) !== edgeId(edge))),
      },
    };
  });

  return (
    <ReactFlow
      nodes={nodes}
      edges={drawn}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      fitView
      minZoom={0.2}
      // the canvas reads left to right, and so do the value columns under it
      onNodeDragStop={() => onOrder([...nodes].sort((a, b) => a.position.x - b.position.x).map((n) => Number(n.id)))}
      onConnect={(connection) => {
        const from = Number(connection.source);
        const to = Number(connection.target);
        // an arrow from a capture to itself asks nothing, and a second one between the same
        // pair either way round would be two answers to one question
        const taken = edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
        if (from === to || taken) {
          return;
        }
        onEdges([...edges, { from, to, relation: DEFAULT_RELATION }]);
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
