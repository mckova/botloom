import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { api, portsFor, type Agent, type FlowNode, type NodeType } from "../api";
import ConfigPanel from "./ConfigPanel";
import Simulator from "./Simulator";

type BLData = { node: FlowNode; def?: NodeType; active?: boolean };
type BLNode = Node<BLData, "bl">;

const CATEGORY_COLORS: Record<string, string> = {
  trigger: "#10b981",
  message: "#6d5dfc",
  logic: "#f59e0b",
  ai: "#ec4899",
  integration: "#0ea5e9",
};

function BotLoomNode({ data, selected }: NodeProps<BLNode>) {
  const { node, def } = data;
  const ports = portsFor(node, def);
  const color = CATEGORY_COLORS[def?.category ?? "logic"];
  const preview = String(node.config.text ?? node.config.question ?? node.config.instructions ?? node.config.url ?? node.config.key ?? "").slice(0, 70);
  return (
    <div className={`fnode ${selected ? "selected" : ""} ${data.active ? "active" : ""}`} style={{ borderTopColor: color }}>
      {!def?.trigger && <Handle type="target" position={Position.Left} />}
      <div className="fnode-head">
        <span>{def?.icon ?? "❔"}</span>
        <b dir="auto">{node.label || def?.label || node.type}</b>
      </div>
      {preview && (
        <div className="fnode-body" dir="auto">
          {preview}
        </div>
      )}
      <div className="fnode-ports">
        {ports.map((p) => (
          <div key={p} className="fnode-port">
            <span dir="auto">{p}</span>
            <Handle type="source" id={p} position={Position.Right} style={{ background: color }} />
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { bl: BotLoomNode };

function toRF(agent: Agent, types: NodeType[]) {
  const def = (t: string) => types.find((d) => d.type === t);
  const nodes: BLNode[] = agent.flow.nodes.map((n, i) => ({
    id: n.id,
    type: "bl",
    position: n.position ?? { x: i * 260, y: 0 },
    data: { node: n, def: def(n.type) },
  }));
  const edges: Edge[] = agent.flow.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourcePort ?? "out", label: e.sourcePort && e.sourcePort !== "out" ? e.sourcePort : undefined, animated: false }));
  return { nodes, edges };
}

export default function Builder({ agent, types, onSaved }: { agent: Agent; types: NodeType[]; onSaved: () => void }) {
  const initial = useMemo(() => toRF(agent, types), [agent.id, types.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<BLNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [showSim, setShowSim] = useState(true);
  const [activeNodes, setActiveNodes] = useState<string[]>([]);

  useEffect(() => {
    const r = toRF(agent, types);
    setNodes(r.nodes);
    setEdges(r.edges);
  }, [types.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, active: activeNodes.includes(n.id) } })));
  }, [activeNodes, setNodes]);

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((es) => addEdge({ ...c, id: `e_${Date.now().toString(36)}`, label: c.sourceHandle && c.sourceHandle !== "out" ? c.sourceHandle : undefined }, es.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle))));
      setDirty(true);
    },
    [setEdges],
  );

  const addNode = (def: NodeType) => {
    const id = `${def.type.split(".").pop()}_${Math.random().toString(36).slice(2, 6)}`;
    const config: Record<string, any> = {};
    for (const f of def.fields) if (f.default !== undefined) config[f.key] = f.default;
    const maxX = Math.max(0, ...nodes.map((n) => n.position.x));
    const n: BLNode = { id, type: "bl", position: { x: maxX + 280, y: 80 }, data: { node: { id, type: def.type, config }, def } };
    setNodes((ns) => [...ns, n]);
    setSelectedId(id);
    setDirty(true);
  };

  const updateNode = (id: string, patch: Partial<FlowNode>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, node: { ...n.data.node, ...patch, config: { ...n.data.node.config, ...(patch.config ?? {}) } } } } : n)));
    setDirty(true);
  };

  const deleteNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
    setDirty(true);
  };

  const save = async () => {
    const flow = {
      nodes: nodes.map((n) => ({ ...n.data.node, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourcePort: e.sourceHandle ?? "out" })),
    };
    try {
      const res = await api<Agent>(`/api/agents/${agent.id}`, { method: "PUT", json: { name: agent.name, description: agent.description, settings: agent.settings, flow } });
      setDirty(false);
      const w = res.validation?.warnings ?? [];
      setStatus(w.length ? { kind: "warn", text: `Saved with ${w.length} warning(s): ${w.join("; ")}` } : { kind: "ok", text: "Saved" });
      onSaved();
    } catch (e: any) {
      setStatus({ kind: "err", text: e.message });
    }
  };

  const selected = nodes.find((n) => n.id === selectedId);
  const grouped = useMemo(() => {
    const g: Record<string, NodeType[]> = {};
    for (const t of types) (g[t.category] ??= []).push(t);
    return g;
  }, [types]);

  return (
    <div className="builder">
      <div className="palette">
        {Object.entries(grouped).map(([cat, defs]) => (
          <div key={cat}>
            <div className="palette-cat" style={{ color: CATEGORY_COLORS[cat] }}>
              {cat}
            </div>
            {defs.map((d) => (
              <button key={d.type} className="palette-item" title={d.description} onClick={() => addNode(d)}>
                <span>{d.icon}</span> {d.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="canvas">
        <div className="canvas-toolbar">
          <button className="primary" onClick={save} disabled={!dirty}>
            {dirty ? "Save flow" : "Saved"}
          </button>
          <button onClick={() => setShowSim((s) => !s)}>{showSim ? "Hide" : "Show"} simulator</button>
          {status && <span className={`status ${status.kind}`}>{status.text}</span>}
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(c) => {
            onNodesChange(c);
            if (c.some((x) => x.type === "position" && x.dragging === false)) setDirty(true);
          }}
          onEdgesChange={(c) => {
            onEdgesChange(c);
            if (c.some((x) => x.type === "remove")) setDirty(true);
          }}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          deleteKeyCode={["Delete"]}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.2}
        >
          <Background gap={20} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {selected ? (
        <ConfigPanel
          node={selected.data.node}
          def={selected.data.def}
          agentId={agent.id}
          onChange={(patch) => updateNode(selected.id, patch)}
          onDelete={() => deleteNode(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      ) : (
        showSim && <Simulator agent={agent} dirty={dirty} onTrace={setActiveNodes} onActivity={onSaved} />
      )}
    </div>
  );
}
