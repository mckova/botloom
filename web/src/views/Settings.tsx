import { useState } from "react";
import { api, type Agent } from "../api";

const TOOLS = [
  ["knowledge_search", "Search knowledge base"],
  ["save_lead", "Save lead to Google Sheets"],
  ["book_appointment", "Book in Google Calendar"],
  ["send_email", "Send email (Gmail)"],
  ["lookup_order", "Look up order (HTTP API)"],
  ["handoff_to_human", "Hand off to a human"],
];

export default function Settings({ agent, onSaved, onDeleted }: { agent: Agent; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [s, setS] = useState(agent.settings);
  const [msg, setMsg] = useState("");
  const allowed = s.allowedTools ?? TOOLS.map((t) => t[0]);

  return (
    <div className="pad narrow">
      <div className="card">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} dir="auto" />
        </label>
        <label className="field">
          <span>Language (UI defaults, error messages)</span>
          <select value={s.language ?? "en"} onChange={(e) => setS({ ...s, language: e.target.value as "he" | "en" })}>
            <option value="en">English</option>
            <option value="he">עברית</option>
          </select>
        </label>
        <label className="field">
          <span>Default model</span>
          <input value={s.model ?? ""} placeholder="claude-opus-5-5" onChange={(e) => setS({ ...s, model: e.target.value || undefined })} />
        </label>
        <label className="field">
          <span>Persona / system prompt (shared by every AI node)</span>
          <textarea rows={4} value={s.systemPrompt ?? ""} onChange={(e) => setS({ ...s, systemPrompt: e.target.value })} dir="auto" />
        </label>
        <div className="field">
          <span>Tools any AI node in this agent may use (guardrail)</span>
          <div className="checks">
            {TOOLS.map(([id, label]) => (
              <label key={id} className="check">
                <input type="checkbox" checked={allowed.includes(id)} onChange={(e) => setS({ ...s, allowedTools: e.target.checked ? [...allowed, id] : allowed.filter((x) => x !== id) })} />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              await api(`/api/agents/${agent.id}`, { method: "PUT", json: { name, description, settings: s, flow: agent.flow } });
              setMsg("Saved");
              onSaved();
            }}
          >
            Save settings
          </button>
          <span className="ok small">{msg}</span>
          <span className="spacer" />
          <button
            className="danger"
            onClick={async () => {
              if (!confirm("Delete this agent and all its data?")) return;
              await api(`/api/agents/${agent.id}`, { method: "DELETE" });
              onDeleted();
            }}
          >
            Delete agent
          </button>
        </div>
      </div>
      <div className="card">
        <h3>Export</h3>
        <p className="muted small">The whole agent is plain JSON (nodes, edges, settings), easy to version in git.</p>
        <button
          onClick={() => {
            const blob = new Blob([JSON.stringify({ name: agent.name, description: agent.description, settings: agent.settings, flow: agent.flow }, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${agent.name.replace(/\W+/g, "-") || "agent"}.json`;
            a.click();
          }}
        >
          Download JSON
        </button>
      </div>
    </div>
  );
}
