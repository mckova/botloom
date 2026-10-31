import { useEffect, useRef, useState } from "react";
import { api, type Agent, type OutMessage, type Run } from "../api";

interface Line {
  who: "me" | "bot" | "sys";
  msg: OutMessage;
}

export default function Simulator({ agent, dirty, onTrace, onActivity }: { agent: Agent; dirty: boolean; onTrace: (ids: string[]) => void; onActivity?: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [contact] = useState(() => `sim-${Math.random().toString(36).slice(2, 8)}`);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [vars, setVars] = useState<Record<string, any>>({});
  const logRef = useRef<HTMLDivElement>(null);
  const he = agent.settings.language === "he";

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  const send = async (t: string, buttonId?: string) => {
    if (busy) return;
    setBusy(true);
    if (t) setLines((l) => [...l, { who: "me", msg: { text: t } }]);
    try {
      const r = await api(`/api/agents/${agent.id}/chat`, { method: "POST", json: { contactId: contact, contactName: he ? "מאיה" : "Maya", text: t, buttonId } });
      setLines((l) => [...l, ...r.messages.map((m: OutMessage) => ({ who: "bot" as const, msg: m }))]);
      if (r.run.status === "handoff") setLines((l) => [...l, { who: "sys", msg: { text: "Conversation handed to a human (see Conversations)" } }]);
      if (r.run.status === "failed") setLines((l) => [...l, { who: "sys", msg: { text: `Run failed: ${r.run.error}` } }]);
      setLastRun(r.run);
      setVars(Object.fromEntries(Object.entries(r.session.vars).filter(([k]) => !k.startsWith("__"))));
      onTrace(r.run.steps.map((s: any) => s.nodeId));
      onActivity?.();
    } catch (e: any) {
      setLines((l) => [...l, { who: "sys", msg: { text: e.message } }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-right sim">
      <div className="panel-head">
        <b>Test chat</b>
        <span className="spacer" />
        <button className="ghost small" onClick={() => send("/restart")}>
          Restart
        </button>
      </div>
      {dirty && <div className="status warn small">Unsaved changes: save the flow to test them.</div>}
      <div className="sim-log" ref={logRef} dir={he ? "rtl" : "ltr"}>
        {lines.length === 0 && <div className="muted small">Say hi to start the flow. Nodes that run light up on the canvas.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`bubble ${l.who}`}>
            {l.msg.text && <div>{l.msg.text}</div>}
            {l.msg.buttons && (
              <div className="bubble-btns">
                {l.msg.buttons.map((b) => (
                  <button key={b.id} onClick={() => send(b.label, b.id)}>
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="bubble bot typing">…</div>}
      </div>
      <form
        className="sim-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          send(text.trim());
          setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={he ? "כתבו הודעה…" : "Type a message…"} dir="auto" />
        <button className="primary">Send</button>
      </form>
      {lastRun && (
        <details className="sim-debug">
          <summary>
            Last run: {lastRun.status} · {lastRun.steps.length} steps · {lastRun.ms} ms
          </summary>
          <div className="small">
            {lastRun.steps.map((s, i) => (
              <div key={i}>
                {s.error ? "❌" : "✓"} {s.nodeId} <span className="muted">({s.type}{s.port ? ` → ${s.port}` : ""}, {s.ms} ms)</span>
              </div>
            ))}
          </div>
          <div className="small muted">Variables</div>
          <pre>{JSON.stringify(vars, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
