import { useEffect, useState } from "react";
import { api, type Agent, type NodeType, type Run } from "../api";

export default function Runs({ agent, types }: { agent: Agent; types: NodeType[] }) {
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
  const icon = (t: string) => types.find((d) => d.type === t)?.icon ?? "•";

  return (
    <div className="split">
      <div className="list">
        <div className="row pad">
          <button className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}>
            Runs ({runs.length})
          </button>
          <button className={view === "integrations" ? "active" : ""} onClick={() => setView("integrations")}>
            Integration calls ({log.length})
          </button>
        </div>
        {view === "runs" &&
          runs.map((r) => (
            <div key={r.id} className={`list-item ${r.id === run?.id ? "active" : ""}`} onClick={() => setSel(r.id)}>
              <div className="row">
                <span className={`dot ${r.status}`} />
                <b>{r.trigger}</b>
                <span className="spacer" />
                <span className="muted small">{r.ms} ms</span>
              </div>
              <div className="muted small">
                {new Date(r.startedAt).toLocaleTimeString()} · {r.status} · {r.steps.length} steps
              </div>
            </div>
          ))}
        {view === "integrations" &&
          log.map((l) => (
            <div key={l.id} className="list-item">
              <div className="row">
                <b>
                  {l.service}:{l.action}
                </b>
                <span className="spacer" />
                <span className={`pill ${l.mode === "live" ? "ok" : ""}`}>{l.mode}</span>
              </div>
              <pre className="tiny">{JSON.stringify(l.request, null, 1).slice(0, 300)}</pre>
            </div>
          ))}
      </div>
      <div className="detail pad">
        {!run ? (
          <div className="muted">No runs yet.</div>
        ) : (
          <>
            <h3>
              Run {run.id} <span className={`pill ${run.status}`}>{run.status}</span>
            </h3>
            {run.error && <div className="status err">{run.error}</div>}
            <div className="timeline">
              {run.steps.map((s, i) => (
                <div key={i} className={`tl-step ${s.error ? "err" : ""}`}>
                  <div className="tl-head">
                    <span>{icon(s.type)}</span>
                    <b>{s.nodeId}</b>
                    <span className="muted small">{s.type}</span>
                    {s.port && <span className="pill">→ {s.port}</span>}
                    <span className="spacer" />
                    <span className="muted small">{s.ms} ms</span>
                  </div>
                  {s.error && <div className="status err small">{s.error}</div>}
                  {s.input && <pre className="tiny">in: {JSON.stringify(s.input)}</pre>}
                  {s.output?.usage && (
                    <div className="muted small">
                      🧠 {s.output.provider} · {s.output.usage.inputTokens.toLocaleString()} in / {s.output.usage.outputTokens.toLocaleString()} out tokens
                    </div>
                  )}
                  {s.output?.toolCalls?.length > 0 && (
                    <div className="tools">
                      {s.output.toolCalls.map((t: any, j: number) => (
                        <div key={j} className="tool-call small">
                          🛠 <b>{t.name}</b>({JSON.stringify(t.input)}) → <span className="muted">{String(t.result).slice(0, 200)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {s.output && <pre className="tiny">out: {JSON.stringify(s.output, null, 1).slice(0, 800)}</pre>}
                </div>
              ))}
            </div>
            {run.outbox.length > 0 && (
              <>
                <h4>Messages sent</h4>
                {run.outbox.map((m, i) => (
                  <div key={i} className="bubble bot" dir="auto">
                    {m.text}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
