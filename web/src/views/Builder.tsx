import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,

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
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { NodeIcon, CATEGORY_COLORS } from "../components/NodeIcon";
import ConfigPanel from "./ConfigPanel";
import Simulator from "./Simulator";

type BLData = { node: FlowNode; def?: NodeType; active?: boolean };
type BLNode = Node<BLData, "bl">;


function BotLoomNode({ data, selected }: NodeProps<BLNode>) {
  const { node, def } = data;
  const ports = portsFor(node, def);
  const color = CATEGORY_COLORS[def?.category ?? "logic"];
  const preview = String(node.config.text ?? node.config.question ?? node.config.instructions ?? node.config.url ?? node.config.key ?? "").slice(0, 70);
  return (
    <div className={`fnode ${selected ? "selected" : ""} ${data.active ? "active" : ""}`} style={{ ["--cat" as any]: color }}>
      {!def?.trigger && <Handle type="target" position={Position.Left} />}
      <div className="fnode-head">
        <NodeIcon type={node.type} />
        <b dir="auto">{node.label || def?.label || node.type}</b>
      </div>
      {node.label && def?.label && node.label !== def.label && <div className="fnode-type">{def.label}</div>}
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

const CAT_LABELS: Record<string, string> = { trigger: "Triggers", message: "Messages", logic: "Logic", ai: "AI", integration: "Integrations" };

export default function Builder({ agent, types, onSaved }: { agent: Agent; types: NodeType[]; onSaved: () => void }) {
  const initial = useMemo(() => toRF(agent, types), [agent.id, types.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<BLNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [showSim, setShowSim] = useState(true);
  const flowRef = useRef<{ fitView: (o?: object) => unknown } | null>(null);
  const FIT = { padding: { top: 0.14, left: 0.05, right: 0.05, bottom: 0.05 }, maxZoom: 1 };
  // The canvas changes width when the side panel opens or closes; refit so the flow stays readable.
  useEffect(() => {
    const t = setTimeout(() => flowRef.current?.fitView({ ...FIT, duration: 160 }), 60);
    return () => clearTimeout(t);
  }, [showSim]);
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
      setStatus(w.length ? { kind: "warn", text: `Saved with ${w.length} warning${w.length === 1 ? "" : "s"}: ${w.join("; ")}` } : null);
      if (!w.length) toast.success("Flow saved");
      onSaved();
    } catch (e: any) {
      setStatus({ kind: "err", text: e.message });
    }
  };

  /** Put a flow proposed by the AI copilot on the canvas; the user reviews it and saves (or reloads to discard). */
  const applyProposal = (flow: Agent["flow"]) => {
    const r = toRF({ ...agent, flow }, types);
    setNodes(r.nodes);
    setEdges(r.edges);
    setSelectedId(null);
    setDirty(true);
    setStatus({ kind: "warn", text: "Claude's changes are on the canvas. Review them, then save." });
  };

  const selected = nodes.find((n) => n.id === selectedId);
  const grouped = useMemo(() => {
    const g: Record<string, NodeType[]> = {};
    for (const t of types) (g[t.category] ??= []).push(t);
    return g;
  }, [types]);

  return (
    <div className={`builder ${!selected && !showSim ? "no-side" : ""}`}>
      <div className="palette">
        {Object.entries(grouped).map(([cat, defs]) => (
          <div key={cat}>
            <div className="palette-cat">
              {CAT_LABELS[cat] ?? cat}
            </div>
            {defs.map((d) => (
              <button key={d.type} className="palette-item" style={{ ["--cat" as any]: CATEGORY_COLORS[cat] }} title={d.description} onClick={() => addNode(d)}>
                <NodeIcon type={d.type} size={15} />
                <span className="palette-label">{d.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="canvas">
        {status && (
          <div className={`status ${status.kind}`} role="status" style={{ position: "absolute", zIndex: 10, bottom: 12, left: "50%", transform: "translateX(-50%)", maxWidth: "70%" }}>
            {status.text}
          </div>
        )}
        <div className="canvas-toolbar">
          <Copilot agentId={agent.id} onApply={applyProposal} />
          <div className="toolbar-actions">
            <button onClick={() => setShowSim((s) => !s)} aria-pressed={showSim}>
              {showSim ? "Hide test chat" : "Test chat"}
            </button>
            {dirty ? (
              <button className="primary" onClick={save}>
                Save
              </button>
            ) : (
              <span className="saved-state" role="status">
                Saved
              </span>
            )}
          </div>
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
          fitViewOptions={FIT}
          onInit={(inst) => (flowRef.current = inst)}
          minZoom={0.2}
        >
          <Background gap={18} size={1.2} />
          <Controls />
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

/** Flow copilot: describe a change in plain language, Claude edits the flow and explains what it changed. */
function Copilot({ agentId, onApply }: { agentId: string; onApply: (flow: Agent["flow"]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<{ flow: Agent["flow"]; notes: string[]; validation: { errors: string[]; warnings: string[] } } | null>(null);
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 4) {
      setError("Describe the change in a few words, e.g. add a step that asks for the order number.");
      return;
    }
    setBusy(true);
    setError("");
    setProposal(null);
    try {
      setProposal(await api(`/api/agents/${agentId}/revise`, { method: "POST", json: { instruction: text } }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="command">
      <form onSubmit={ask}>
        <Pencil size={14} strokeWidth={1.75} aria-hidden="true" color="var(--ink-faint)" />
        <label className="sr-only" htmlFor="copilot-input">
          Describe a change to this flow
        </label>
        <input ref={inputRef} id="copilot-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe a change, e.g. ping Slack on new leads" dir="auto" />
        {!text && (
          <span className="kbd" aria-hidden="true">
            /
          </span>
        )}
        <button className="dark sm" disabled={busy} aria-busy={busy}>
          {busy ? "Editing…" : "Edit with Claude"}
        </button>
      </form>
      {error && (
        <div className="proposal">
          <span className="err small" role="alert">
            {error}
          </span>
        </div>
      )}
      {proposal && (
        <div className="proposal" aria-live="polite">
          <span className="small soft">Claude changed:</span>
          <ul>
            {proposal.notes.map((n, i) => (
              <li key={i} dir="auto">
                {n}
              </li>
            ))}
          </ul>
          <div className="row">
            <span className="muted small num">
              {proposal.flow.nodes.length} steps · {proposal.validation.errors.length ? `${proposal.validation.errors.length} problems` : "graph checks pass"}
            </span>
            <span className="spacer" />
            <button className="ghost sm" onClick={() => setProposal(null)}>
              Discard
            </button>
            <button
              className="primary sm"
              onClick={() => {
                onApply(proposal.flow);
                setProposal(null);
                setText("");
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
