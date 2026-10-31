import { useEffect, useState } from "react";
import { api, type Agent, type Session } from "../api";

const CH_ICON: Record<string, string> = { telegram: "✈️", whatsapp: "🟢", webchat: "🌐", test: "🧪", webhook: "🪝", schedule: "⏰" };

export default function Conversations({ agent }: { agent: Agent }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [filter, setFilter] = useState<"all" | "handoff">("all");

  const load = () => api<Session[]>(`/api/agents/${agent.id}/sessions`).then(setSessions);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = sessions.filter((s) => !["webhook", "schedule"].includes(s.channel) && (filter === "all" || s.handoff));
  const s = sessions.find((x) => x.id === sel);

  return (
    <div className="split">
      <div className="list">
        <div className="row pad">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
            All
          </button>
          <button className={filter === "handoff" ? "active" : ""} onClick={() => setFilter("handoff")}>
            Needs human ({sessions.filter((x) => x.handoff).length})
          </button>
        </div>
        {list.length === 0 && <div className="muted pad">No conversations yet. Use the test chat or connect a channel.</div>}
        {list.map((x) => (
          <div key={x.id} className={`list-item ${x.id === sel ? "active" : ""}`} onClick={() => setSel(x.id)}>
            <div className="row">
              <span>{CH_ICON[x.channel] ?? "💬"}</span>
              <b dir="auto">{x.contactName || x.contactId}</b>
              <span className="spacer" />
              {x.handoff && <span className="pill warn">human</span>}
              {x.wait && !x.handoff && <span className="pill">waiting</span>}
            </div>
            <div className="muted small" dir="auto">
              {x.history.at(-1)?.text.slice(0, 60)}
            </div>
          </div>
        ))}
      </div>
      <div className="detail">
        {!s ? (
          <div className="muted pad">Select a conversation</div>
        ) : (
          <>
            <div className="row pad">
              <b dir="auto">{s.contactName || s.contactId}</b>
              <span className="muted small">
                {s.channel} · {s.contactId}
              </span>
              <span className="spacer" />
              {s.handoff && <button onClick={() => api(`/api/sessions/${s.id}/release`, { method: "POST" }).then(load)}>Give back to bot</button>}
              <button className="danger" onClick={() => api(`/api/sessions/${s.id}`, { method: "DELETE" }).then(() => (setSel(null), load()))}>
                Delete
              </button>
            </div>
            <div className="transcript">
              {s.history.map((h, i) => (
                <div key={i} className={`bubble ${h.role === "user" ? "me" : "bot"}`} dir="auto">
                  {h.text}
                  <div className="muted tiny">{new Date(h.at).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <form
              className="sim-input"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!reply.trim()) return;
                await api(`/api/sessions/${s.id}/reply`, { method: "POST", json: { text: reply } });
                setReply("");
                load();
              }}
            >
              <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply as a team member…" dir="auto" />
              <button className="primary">Send</button>
            </form>
            <details className="pad">
              <summary>Collected variables</summary>
              <pre>{JSON.stringify(Object.fromEntries(Object.entries(s.vars).filter(([k]) => !k.startsWith("__"))), null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
