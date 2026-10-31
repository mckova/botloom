import { useEffect, useState } from "react";
import { api, type Agent, type NodeType, type Run } from "../api";
import { NodeIcon } from "../components/NodeIcon";
import { when } from "../App";

const TRIGGER_LABEL: Record<string, string> = { "message:test": "Test chat", "message:webchat": "Website chat", "message:telegram": "Telegram", "message:whatsapp": "WhatsApp" };
const triggerLabel = (t: string) => TRIGGER_LABEL[t] ?? t.replace(/^webhook:/, "Webhook ").replace(/^schedule:/, "Schedule ");

export default function Runs({ agent }: { agent: Agent; types: NodeType[] }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [log, setLog] = useState<any[]>([]);
  const [view, setView] = useState<"runs" | "integrations">("runs");

  useEffect(() => {
    const load = () => {
      api<Run[]>(`/api/agents/${agent.id}/runs`).then(setRuns);
      api<any[]>(`/api/agents/${agent.id}/integrations-log`).then(setLog);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [agent.id]);

  const run = runs.find((r) => r.id === sel) ?? runs[0];

  return (
    <div className="split">
      <div className="list">
        <div className="list-head" role="tablist" aria-label="Run history">
          <button role="tab" aria-selected={view === "runs"} onClick={() => setView("runs")}>
            Runs <span className="num muted">{runs.length}</span>
          </button>
          <button role="tab" aria-selected={view === "integrations"} onClick={() => setView("integrations")}>
            Integration calls <span className="num muted">{log.length}</span>
          </button>
        </div>
        {view === "runs" && runs.length === 0 && (
          <div className="empty">
            <b>No runs yet</b>
            <span>Every message, webhook and schedule creates a run you can inspect here.</span>
          </div>
        )}
        {view === "runs" &&
          runs.map((r) => (
            <button key={r.id} className={`list-item ${r.id === run?.id ? "active" : ""}`} onClick={() => setSel(r.id)}>
              <div className="row">
                <span className={`dot ${r.status}`} aria-hidden="true" />
                <span className="who">{triggerLabel(r.trigger)}</span>
                <span className="spacer" />
                <span className="mono muted">{r.ms} ms</span>
              </div>
              <div className="preview num">
                {r.status} · {r.steps.length} {r.steps.length === 1 ? "step" : "steps"} · {when(r.startedAt)}
              </div>
            </button>
          ))}
        {view === "integrations" && log.length === 0 && (
          <div className="empty">
            <b>No integration calls yet</b>
            <span>Google, Telegram, WhatsApp, Slack and Discord calls are recorded here, live or sandbox.</span>
          </div>
        )}
        {view === "integrations" &&
          log.map((l) => (
            <div key={l.id} className="list-item">
              <div className="row">
                <span className="who mono">
                  {l.service}.{l.action.replace(/^\w+\./, "")}
                </span>
                <span className="spacer" />
                <span className={`tag ${l.mode === "live" ? "ok" : ""}`}>{l.mode}</span>
              </div>
              <pre className="tiny">{JSON.stringify(l.request, null, 1).slice(0, 300)}</pre>
            </div>
          ))}
      </div>
      <div className="detail">
        {!run ? (
          <div className="empty">
            <b>Nothing to show</b>
            <span>Send a message in the test chat to create the first run.</span>
          </div>
        ) : (
          <div className="pad">
            <div className="row">
              <h2>{triggerLabel(run.trigger)}</h2>
              <span className={`tag ${run.status}`}>{run.status}</span>
              <span className="spacer" />
              <span className="mono muted">
                <span title={run.id}>{new Date(run.startedAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span> · {run.ms}&nbsp;ms
              </span>
            </div>
            {run.error && (
              <div className="status err" style={{ marginTop: 12 }}>
                {run.error}
              </div>
            )}
            <div className="timeline">
              {run.steps.map((s, i) => (
                <div key={i} className={`tl-step ${s.error ? "err" : ""}`}>
                  <div className="tl-head">
                    <NodeIcon type={s.type} />
                    <b>{s.nodeId}</b>
                    <span className="mono muted">{s.type}</span>
                    {s.port && <span className="tag">{s.port}</span>}
                    <span className="spacer" />
                    <span className="mono muted">{s.ms} ms</span>
                  </div>
                  {s.error && <div className="status err small">{s.error}</div>}
                  {typeof s.output?.text === "string" && s.output.text && (
                    <p className="step-text" dir="auto">
                      {s.output.text}
                    </p>
                  )}
                  {s.output?.usage && (
                    <div className="muted small num" style={{ marginTop: 4 }}>
                      {s.output.provider} · {s.output.usage.inputTokens.toLocaleString()} input / {s.output.usage.outputTokens.toLocaleString()} output tokens
                    </div>
                  )}
                  {s.output?.toolCalls?.length > 0 &&
                    s.output.toolCalls.map((t: any, j: number) => (
                      <div key={j} className="tool-call">
                        <b>{t.name}</b>({JSON.stringify(t.input)}) <span className="muted">returned {String(t.result).slice(0, 200)}</span>
                      </div>
                    ))}
                  {(s.input || s.output) && (
                    <details className="step-data">
                      <summary>Data</summary>
                      {s.input && <pre className="tiny">in: {JSON.stringify(s.input, null, 1)}</pre>}
                      {s.output && <pre className="tiny">out: {JSON.stringify(s.output, null, 1).slice(0, 1600)}</pre>}
                    </details>
                  )}
                </div>
              ))}
            </div>
            {run.outbox.length > 0 && (
              <div className="stack">
                <h3>Messages sent</h3>
                {run.outbox.map((m, i) => (
                  <div key={i} className="bubble bot" dir="auto">
                    {m.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
