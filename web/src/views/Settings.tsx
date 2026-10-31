import { useState } from "react";
import { api, type Agent } from "../api";
import { useConfirm } from "../components/Confirm";
import { toast } from "sonner";

const TOOLS = [
  ["knowledge_search", "Search knowledge base"],
  ["save_lead", "Save lead to Google Sheets"],
  ["check_availability", "Check calendar availability"],
  ["book_appointment", "Book in Google Calendar"],
  ["send_email", "Send email (Gmail)"],
  ["lookup_order", "Look up order (HTTP API)"],
  ["remember", "Long-term memory"],
  ["handoff_to_human", "Hand off to a human"],
];

export default function Settings({ agent, onSaved, onDeleted }: { agent: Agent; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [s, setS] = useState(agent.settings);
  const { confirm, dialog } = useConfirm();
  const allowed = s.allowedTools ?? TOOLS.map((t) => t[0]);

  const save = async () => {
    await api(`/api/agents/${agent.id}`, { method: "PUT", json: { name, description, settings: s, flow: agent.flow } });
    toast.success("Settings saved");
    onSaved();
  };
  return (
    <div className="page">
      {dialog}
      <section className="section">
        <header>
          <h2>Agent</h2>
          <p>Name and description show in the agent list and in team alerts.</p>
        </header>
        <div className="stack">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} dir="auto" />
          </label>
          <label className="field">
            <span>Language</span>
            <select value={s.language ?? "en"} onChange={(e) => setS({ ...s, language: e.target.value as "he" | "en" })}>
              <option value="en">English</option>
              <option value="he">עברית</option>
            </select>
          </label>
        </div>
      </section>
      <section className="section">
        <header>
          <h2>Model and persona</h2>
          <p>Every AI step in this agent shares the persona. Leave the model empty to use the server default.</p>
        </header>
        <div className="stack">
          <label className="field">
            <span>Model</span>
            <input className="mono" value={s.model ?? ""} placeholder="claude-opus-5-5" onChange={(e) => setS({ ...s, model: e.target.value || undefined })} />
          </label>
          <label className="field">
            <span>Persona</span>
            <textarea rows={4} value={s.systemPrompt ?? ""} onChange={(e) => setS({ ...s, systemPrompt: e.target.value })} dir="auto" />
          </label>
        </div>
      </section>
      <section className="section">
        <header>
          <h2>Allowed tools</h2>
          <p>A guardrail over every AI step: a tool that is off here cannot run, whatever a step asks for.</p>
        </header>
        <div className="checks">
          {TOOLS.map(([id, label]) => (
            <label key={id} className="check">
              <input type="checkbox" checked={allowed.includes(id)} onChange={(e) => setS({ ...s, allowedTools: e.target.checked ? [...allowed, id] : allowed.filter((x) => x !== id) })} />
              {label}
            </label>
          ))}
        </div>
      </section>
      <div className="row" style={{ padding: "20px 0" }}>
        <button className="primary" onClick={save}>
          Save settings
        </button>
      </div>
      <section className="section">
        <header>
          <h2>Export</h2>
          <p>The agent is plain JSON: steps, connections and settings. Keep it in git.</p>
        </header>
        <div>
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
      </section>
      <section className="section" style={{ borderBottom: 0 }}>
        <header>
          <h2>Delete agent</h2>
          <p>Removes the flow, conversations, runs, knowledge and channel settings.</p>
        </header>
        <div>
          <button
            className="danger"
            onClick={async () => {
              if (!(await confirm(`Delete “${agent.name}”?`, { body: "Its flow, conversations, runs, knowledge base and channel settings are removed. This cannot be undone.", confirmLabel: "Delete agent" }))) return;
              await api(`/api/agents/${agent.id}`, { method: "DELETE" });
              onDeleted();
            }}
          >
            Delete agent
          </button>
        </div>
      </section>
    </div>
  );
}
