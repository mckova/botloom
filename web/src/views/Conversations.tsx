import { useEffect, useState } from "react";
import { api, type Agent, type Session } from "../api";
import { useConfirm } from "../components/Confirm";
import { when } from "../App";
import { X } from "lucide-react";

const CHANNEL: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp", webchat: "Website", test: "Test chat", slack: "Slack", discord: "Discord" };

interface Brief {
  summary: string;
  customerWants: string;
  sentiment: string;
  urgency: "low" | "medium" | "high";
  nextStep: string;
  by: "claude" | "rules";
}


export default function Conversations({ agent }: { agent: Agent }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "handoff">("all");
  const { confirm, dialog } = useConfirm();

  const load = () => api<Session[]>(`/api/agents/${agent.id}/sessions`).then(setSessions);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const chats = sessions.filter((s) => !["webhook", "schedule"].includes(s.channel));
  const list = chats.filter((s) => filter === "all" || s.handoff);
  const s = sessions.find((x) => x.id === sel);
  const waiting = chats.filter((x) => x.handoff).length;

  return (
    <div className="split">
      {dialog}
      <div className="list">
        <div className="list-head" role="tablist" aria-label="Filter conversations">
          <button role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="num muted">{chats.length}</span>
          </button>
          <button role="tab" aria-selected={filter === "handoff"} onClick={() => setFilter("handoff")}>
            Waiting for a person <span className="num muted">{waiting}</span>
          </button>
        </div>
        {list.length === 0 && (
          <div className="empty small">
            <b>{filter === "handoff" ? "Nobody is waiting for a human" : "No conversations yet"}</b>
            <span>{filter === "handoff" ? "When the agent hands a chat to a person, it lands here with a brief." : "Say hi in the test chat on the Flow tab."}</span>
          </div>
        )}
        {list.map((x) => (
          <button key={x.id} className={`list-item ${x.id === sel ? "active" : ""}`} onClick={() => setSel(x.id)} aria-current={x.id === sel ? "true" : undefined}>
            <div className="row">
              <span className="who truncate" dir="auto">
                {x.contactName || x.contactId}
              </span>
              {x.handoff && <span className="tag warn">Waiting</span>}
              <span className="spacer" />
              <span className="muted tiny num">{when(x.updatedAt)}</span>
            </div>
            <div className="preview truncate" dir="auto">
              <span className="muted">{CHANNEL[x.channel] ?? x.channel} · </span>
              {x.history.at(-1)?.text}
            </div>
          </button>
        ))}
      </div>
      <div className="detail">
        {!s ? (
          <div className="empty">
            <b>Pick a conversation</b>
            <span>Read the transcript, see what the agent remembers, and reply as the team.</span>
          </div>
        ) : (
          <Detail
            key={s.id}
            s={s}
            reload={load}
            onDelete={async () => {
              if (!(await confirm("Delete this conversation?", { body: "The transcript and collected variables are removed. This cannot be undone." }))) return;
              await api(`/api/sessions/${s.id}`, { method: "DELETE" });
              setSel(null);
              load();
            }}
          />
        )}
      </div>
    </div>
  );
}

function Detail({ s, reload, onDelete }: { s: Session; reload: () => void; onDelete: () => void }) {
  const [reply, setReply] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const [memory, setMemory] = useState<{ id: number; fact: string }[]>([]);
  const brief: Brief | undefined = s.vars.__brief;
  const loadMemory = () => api<{ id: number; fact: string }[]>(`/api/sessions/${s.id}/memory`).then(setMemory);
  useEffect(() => {
    loadMemory();
  }, [s.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggest = async () => {
    setDrafting(true);
    setError("");
    try {
      const r = await api<{ draft: string }>(`/api/sessions/${s.id}/suggest`, { method: "POST" });
      setReply(r.draft);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  };
  const vars = Object.fromEntries(Object.entries(s.vars).filter(([k]) => !k.startsWith("__")));

  return (
    <>
      <div className="detail-head">
        <h2 dir="auto">{s.contactName || s.contactId}</h2>
        <span className="muted small">
          {CHANNEL[s.channel] ?? s.channel}
        </span>
        <span className="spacer" />
        {s.handoff && (
          <button className="sm" onClick={() => api(`/api/sessions/${s.id}/release`, { method: "POST" }).then(reload)}>
            Hand back to agent
          </button>
        )}
        <button className="ghost sm danger" onClick={onDelete}>
          Delete
        </button>
      </div>

      {s.handoff && brief && (
        <section className="brief" aria-label="Handoff brief">
          <div className="brief-head">
            <h2>Brief</h2>
            <span className={`tag ${brief.urgency === "high" ? "err" : brief.urgency === "medium" ? "warn" : ""}`}>{brief.urgency} urgency</span>
            <span className="tag">{brief.sentiment}</span>
            <span className="spacer" />
            <span className="muted tiny">{brief.by === "claude" ? "Written by Claude" : "Rule-based (demo provider)"}</span>
          </div>
          <dl>
            <dt>What happened</dt>
            <dd dir="auto">{brief.summary}</dd>
            <dt>They want</dt>
            <dd dir="auto">{brief.customerWants}</dd>
            <dt>Next step</dt>
            <dd dir="auto">{brief.nextStep}</dd>
          </dl>
        </section>
      )}

      <div className="transcript">
        {s.history.map((h, i) => {
          const team = h.text.startsWith("[team] ");
          return (
            <div key={i} className={`bubble ${h.role === "user" ? "me" : team ? "team" : "bot"}`} dir="auto">
              {team ? h.text.slice(7) : h.text}
              <div className="stamp" dir="ltr">
                {team ? "team · " : ""}
                {stampOf(h.at)}
              </div>
            </div>
          );
        })}
      </div>

      <form
        className="sim-input"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!reply.trim()) {
            setError("Write a reply first, or press Draft reply to have Claude suggest one.");
            return;
          }
          setError("");
          await api(`/api/sessions/${s.id}/reply`, { method: "POST", json: { text: reply } });
          setReply("");
          reload();
        }}
      >
        <label className="sr-only" htmlFor="team-reply">
          Reply as a team member
        </label>
        <input id="team-reply" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply as the team" dir="auto" />
        <button type="button" onClick={suggest} disabled={drafting} aria-busy={drafting} title="Claude drafts a reply from the transcript and knowledge base">
          {drafting ? "Drafting…" : "Draft reply"}
        </button>
        <button className="primary">
          Send
        </button>
      </form>
      {error && (
        <div className="status err small" role="alert" style={{ margin: "0 12px 12px" }}>
          {error}
        </div>
      )}

      <div className="side-facts">
        <h3>Remembered about this contact</h3>
        {memory.length === 0 ? (
          <span className="muted small">Nothing yet. Agents with long-term memory save lasting preferences here.</span>
        ) : (
          <div className="memory">
            {memory.map((m) => (
              <span key={m.id} className="tag" dir="auto">
                {m.fact}
                <button aria-label={`Forget: ${m.fact}`} onClick={() => api(`/api/sessions/${s.id}/memory/${m.id}`, { method: "DELETE" }).then(loadMemory)}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <details>
          <summary>Collected variables</summary>
          <pre>{JSON.stringify(vars, null, 2)}</pre>
        </details>
      </div>
    </>
  );
}

// Today shows the time only; older messages add the date.
function stampOf(at: string | number) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}
