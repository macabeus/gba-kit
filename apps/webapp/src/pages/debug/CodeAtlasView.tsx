import { graphlib, layout } from '@dagrejs/dagre';
import {
  Background,
  Controls,
  type Edge,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Panel } from '../../components/Panel';
import { CodeAtlasNode, type CodeAtlasNodeType } from './CodeAtlasNode';
import {
  type MizuchiDb,
  buildAddressIndex,
  fetchMizuchiDbFromServer,
  loadMizuchiDbFromFile,
  lookupFunctionByPC,
} from './mizuchi-db';

interface CodeAtlasViewProps {
  pc: number;
  hasMizuchiDb: boolean;
}

const NODE_WIDTH = 380;
const NODE_HEIGHT_BASE = 80;
const NODE_HEIGHT_ASM = 200;
const NODE_HEIGHT_C = 320;

const nodeTypes: NodeTypes = { codeAtlas: CodeAtlasNode };

/** Compute dagre layout from the DB structure. Independent of active function. */
function computeLayout(db: MizuchiDb) {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, edgesep: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  const fnById = new Map(db.decompFunctions.map((fn) => [fn.id, fn]));

  for (const fn of db.decompFunctions) {
    const height = fn.cCode ? NODE_HEIGHT_C : NODE_HEIGHT_ASM;
    g.setNode(fn.id, { width: NODE_WIDTH, height });
  }

  for (const fn of db.decompFunctions) {
    for (const calleeId of fn.callsFunctions) {
      if (fnById.has(calleeId)) {
        g.setEdge(fn.id, calleeId);
      }
    }
  }

  layout(g);

  const nodes: CodeAtlasNodeType[] = [];
  for (const nodeId of g.nodes()) {
    const nodeData = g.node(nodeId);
    const fn = fnById.get(nodeId);
    if (!fn || !nodeData) continue;

    nodes.push({
      id: nodeId,
      type: 'codeAtlas',
      position: { x: nodeData.x - NODE_WIDTH / 2, y: nodeData.y - (nodeData.height ?? NODE_HEIGHT_BASE) / 2 },
      data: { fn, isActive: false, pc: 0 },
      style: { pointerEvents: 'all' },
    });
  }

  const edges: Edge[] = [];
  for (const edge of g.edges()) {
    edges.push({
      id: `${edge.v}->${edge.w}`,
      source: edge.v,
      target: edge.w,
      style: { stroke: 'var(--color-slate-600)', strokeWidth: 1.5 },
      animated: false,
    });
  }

  return { nodes, edges };
}

// ─── Inner component (has access to useReactFlow) ────────────────────

interface CodeAtlasFlowInnerProps {
  db: MizuchiDb;
  activeFunctionId: string | null;
  pc: number;
}

function CodeAtlasFlowInner({ db, activeFunctionId, pc }: CodeAtlasFlowInnerProps) {
  const { setCenter, getNode } = useReactFlow();

  // Layout computed once when db loads — dagre never re-runs for active function changes
  const layoutResult = useMemo(() => computeLayout(db), [db]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CodeAtlasNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Set initial layout — wrapped in startTransition so dagre doesn't block the UI
  useEffect(() => {
    startTransition(() => {
      setNodes(layoutResult.nodes);
      setEdges(layoutResult.edges);
    });
  }, [layoutResult, setNodes, setEdges]);

  // Only update the nodes that actually changed (old active → inactive, new active → active + pc)
  const prevActiveRef = useRef<string | null>(null);

  useEffect(() => {
    const prevId = prevActiveRef.current;
    prevActiveRef.current = activeFunctionId;

    setNodes((prev) =>
      prev.map((node) => {
        if (node.id !== activeFunctionId && node.id !== prevId) return node;
        const shouldBeActive = node.id === activeFunctionId;
        return { ...node, data: { ...node.data, isActive: shouldBeActive, pc: shouldBeActive ? pc : node.data.pc } };
      }),
    );
    setEdges((prev) =>
      prev.map((edge) => {
        if (edge.source !== activeFunctionId && edge.source !== prevId) return edge;
        const shouldAnimate = edge.source === activeFunctionId;
        return { ...edge, animated: shouldAnimate };
      }),
    );
  }, [activeFunctionId, pc, setNodes, setEdges]);

  const centerOnActive = useCallback(
    (fnId: string) => {
      const node = getNode(fnId);
      if (node) {
        setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + (node.measured?.height ?? NODE_HEIGHT_BASE) / 2, {
          zoom: 0.8,
          duration: 300,
        });
      }
    },
    [getNode, setCenter],
  );

  // Center on active function — both on initial load and when it changes.
  // Uses nodes.length to also trigger after the layout effect populates nodes
  // (onInit fires too early, before nodes are set via startTransition).
  const hasCenteredRef = useRef(false);

  useEffect(() => {
    if (!activeFunctionId || nodes.length === 0) return;
    // On first mount, always center; after that, only when activeFunctionId changes
    if (!hasCenteredRef.current) {
      hasCenteredRef.current = true;
      centerOnActive(activeFunctionId);
      return;
    }
    centerOnActive(activeFunctionId);
  }, [activeFunctionId, nodes.length, centerOnActive]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onlyRenderVisibleElements
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      nodesFocusable={false}
      minZoom={0.05}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background color="#334155" gap={24} size={1} />
      <Controls
        showInteractive={false}
        className="!bg-slate-800 !border-slate-700 !shadow-lg [&>button]:!bg-slate-700 [&>button]:!border-slate-600 [&>button]:!text-slate-300 [&>button:hover]:!bg-slate-600"
      />
    </ReactFlow>
  );
}

// ─── Outer component (loading, file picker, address mapping) ─────────

export function CodeAtlasView({ pc, hasMizuchiDb }: CodeAtlasViewProps) {
  const [db, setDb] = useState<MizuchiDb | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-fetch from dev server on mount
  useEffect(() => {
    if (hasMizuchiDb && !db) {
      setLoading(true);
      fetchMizuchiDbFromServer()
        .then((data) => {
          if (data) setDb(data);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [hasMizuchiDb, db]);

  const handleFileLoad = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const data = await loadMizuchiDbFromFile(file);
      setDb(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setLoading(false);
    }
  }, []);

  const addressIndex = useMemo(() => (db ? buildAddressIndex(db) : []), [db]);
  const activeFunctionId = useMemo(() => lookupFunctionByPC(addressIndex, pc), [addressIndex, pc]);

  if (!db) {
    return (
      <Panel title="Code Atlas" className="h-full">
        <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400 text-xs">
          {loading ? (
            <span>Loading function database...</span>
          ) : error ? (
            <span className="text-red-400">{error}</span>
          ) : (
            <>
              <p>
                Load a <code className="text-slate-300">mizuchi-db.json</code> to explore the call graph.
              </p>
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600 transition-colors text-xs"
                onClick={() => fileInputRef.current?.click()}
              >
                Load mizuchi-db.json
              </button>

              <button
                type="button"
                className="px-3 py-1.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600 transition-colors text-xs"
                onClick={() => {
                  window.open('https://github.com/macabeus/mizuchi', '_blank');
                }}
              >
                Learn how to create <code className="text-slate-300">mizuchi-db.json</code>
              </button>

              <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileLoad} />
              {hasMizuchiDb && (
                <p className="text-slate-500 text-[10px]">
                  Auto-loading from dev server failed. Load manually instead.
                </p>
              )}
            </>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Code Atlas" className="h-full" scroll={false} contentClassName="relative">
      <ReactFlowProvider>
        <CodeAtlasFlowInner db={db} activeFunctionId={activeFunctionId} pc={pc} />
      </ReactFlowProvider>
    </Panel>
  );
}
