import { useState } from "react";
import { api, isVisible, type FieldDef, type FlowNode, type NodeType } from "../api";

interface Props {
  node: FlowNode;
  def?: NodeType;
  agentId: string;
  onChange: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function ConfigPanel({ node, def, agentId, onChange, onDelete, onClose }: Props) {
  const [fireResult, setFireResult] = useState<string>("");
  const set = (key: string, value: any) => onChange({ config: { [key]: value } });

  const fire = async () => {
    try {
      const payload = node.type === "trigger.webhook" ? { id: "TEST-1", customer: "Test Customer", email: "test@example.com", total: 650 } : {};
      const r = await api(`/api/agents/${agentId}/trigger/${node.id}`, { method: "POST", json: payload });
      setFireResult(`Run ${r.run.status} in ${r.run.ms} ms, ${r.run.steps.length} steps. See "Runs & traces".`);
    } catch (e: any) {
      setFireResult(`Error: ${e.message}. Save the flow first.`);
    }
  };

  return (
    <div className="panel-right">
      <div className="panel-head">
        <span>{def?.icon}</span>
        <b>{def?.label ?? node.type}</b>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="muted small">{def?.description}</p>
      <label className="field">
        <span>Node label</span>
        <input value={node.label ?? ""} placeholder={def?.label} onChange={(e) => onChange({ label: e.target.value })} dir="auto" />
      </label>
      <div className="muted small">id: {node.id}</div>
      {def?.fields.filter((f) => isVisible(f, node.config, def.fields)).map((f) => <Field key={f.key} f={f} value={node.config[f.key]} onChange={(v) => set(f.key, v)} />)}

      {node.type === "trigger.webhook" && (
        <div className="hint">
          <div className="small">Endpoint</div>
          <code>
            POST {location.origin}/hooks/{agentId}/{node.config.key || "key"}
          </code>
        </div>
      )}
      {def?.trigger && node.type !== "trigger.message" && (
        <div className="hint">
          <button onClick={fire}>▶ Run now with sample data</button>
          {fireResult && <div className="small">{fireResult}</div>}
        </div>
      )}
      <div className="hint small muted">
        Templates: <code>{"{{vars.x}}"}</code> <code>{"{{message.text}}"}</code> <code>{"{{contact.name}}"}</code> <code>{"{{message.payload.field}}"}</code> <code>{"{{now.date}}"}</code>. Filters: <code>| upper</code>{" "}
        <code>| default: 'x'</code>
      </div>
      <button className="danger" onClick={onDelete}>
        Delete node
      </button>
    </div>
  );
}

function Field({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) {
  const v = value ?? f.default ?? "";
  let input: React.ReactNode;
  switch (f.kind) {
    case "textarea":
      input = <textarea rows={4} value={v} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} dir="auto" />;
      break;
    case "lines":
      input = <textarea rows={4} value={Array.isArray(v) ? v.join("\n") : v} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} dir="auto" />;
      break;
    case "number":
      input = <input type="number" value={v} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
      break;
    case "boolean":
      input = <input type="checkbox" checked={!!(value ?? f.default)} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "select":
      input = (
        <select value={v} onChange={(e) => onChange(e.target.value)}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case "multiselect": {
      const arr: string[] = Array.isArray(v) ? v : [];
      input = (
        <div className="checks">
          {f.options?.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "keyvalue": {
      const obj: Record<string, string> = v && typeof v === "object" ? v : {};
      const entries = Object.entries(obj);
      const write = (list: [string, string][]) => onChange(Object.fromEntries(list.filter(([k]) => k !== "" || list.length === 1)));
      input = (
        <div className="kv">
          {[...entries, ["", ""] as [string, string]].map(([k, val], i) => (
            <div key={i} className="kv-row">
              <input
                placeholder="key"
                value={k}
                onChange={(e) => {
                  const next = [...entries];
                  next[i] = [e.target.value, val];
                  write(next);
                }}
              />
              <input
                placeholder="value"
                value={val}
                dir="auto"
                onChange={(e) => {
                  const next = [...entries];
                  next[i] = [k || `field${i + 1}`, e.target.value];
                  write(next);
                }}
              />
            </div>
          ))}
        </div>
      );
      break;
    }
    default:
      input = <input value={v} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} dir="auto" />;
  }
  return (
    <label className={`field ${f.kind === "boolean" ? "inline" : ""}`}>
      <span>{f.label}</span>
      {input}
      {f.help && <em className="muted small">{f.help}</em>}
    </label>
  );
}
