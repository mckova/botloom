import { useEffect, useState, useCallback } from "react";
import { api, type Agent, type NodeType } from "./api";
import Builder from "./views/Builder";
import Conversations from "./views/Conversations";
import Runs from "./views/Runs";
import Knowledge from "./views/Knowledge";
import Channels from "./views/Channels";
import Settings from "./views/Settings";

type Tab = "builder" | "conversations" | "runs" | "knowledge" | "channels" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "builder", label: "Flow builder" },
  { id: "conversations", label: "Conversations" },
  { id: "runs", label: "Runs & traces" },
  { id: "knowledge", label: "Knowledge" },
  { id: "channels", label: "Channels" },
  { id: "settings", label: "Settings" },
];

interface Template {
  id: string;
  name: string;
  description: string;
  language: string;
  nodes: number;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [types, setTypes] = useState<NodeType[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [health, setHealth] = useState<{ llm: string; google: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(() => location.hash.slice(1).split("/")[0] || null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.split("/")[1] as Tab) || "builder");

  const refresh = useCallback(async () => setAgents(await api<Agent[]>("/api/agents")), []);
  useEffect(() => {
    refresh();
    api<NodeType[]>("/api/node-types").then(setTypes);
    api<Template[]>("/api/templates").then(setTemplates);
    api("/api/health").then(setHealth);
  }, [refresh]);
  useEffect(() => {
    location.hash = selected ? `${selected}/${tab}` : "";
  }, [selected, tab]);

  const create = async (templateId?: string) => {
    const a = templateId
      ? await api<Agent>(`/api/agents/from-template/${templateId}`, { method: "POST" })
      : await api<Agent>("/api/agents", {
          method: "POST",
          json: { name: "New agent", description: "", flow: { nodes: [{ id: "start", type: "trigger.message", position: { x: 0, y: 0 }, config: {} }], edges: [] }, settings: { language: "en" } },
        });
    await refresh();
    setSelected(a.id);
    setTab("builder");
  };

  const agent = agents.find((a) => a.id === selected);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => setSelected(null)}>
          🧶 <b>BotLoom</b>
        </div>
        <button className="primary block" onClick={() => setSelected(null)}>
          + New agent
        </button>
        <div className="agent-list">
          {agents.map((a) => (
            <div key={a.id} className={`agent-item ${a.id === selected ? "active" : ""}`} onClick={() => setSelected(a.id)}>
              <div className="agent-name" dir="auto">
                {a.name}
              </div>
              <div className="muted small">
                {a.stats?.contacts ?? 0} contacts · {a.stats?.runs ?? 0} runs
              </div>
            </div>
          ))}
        </div>
        {health && (
          <div className="health small">
            <div>
              LLM: <span className={health.llm === "mock" ? "warn" : "ok"}>{health.llm === "mock" ? "demo (no key)" : "Claude"}</span>
            </div>
            <div>
              Google: <span className={health.google === "live" ? "ok" : "warn"}>{health.google}</span>
            </div>
          </div>
        )}
      </aside>

      <main className="main">
        {!agent ? (
          <Home
            templates={templates}
            agents={agents}
            onCreate={create}
            onOpen={setSelected}
            onDesigned={async (id) => {
              await refresh();
              setSelected(id);
              setTab("builder");
            }}
          />
        ) : (
          <>
            <header className="topbar">
              <div>
                <h2 dir="auto">{agent.name}</h2>
                <div className="muted small" dir="auto">
                  {agent.description}
                </div>
              </div>
              <nav className="tabs">
                {TABS.map((t) => (
                  <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </nav>
            </header>
            <section className="content">
              {tab === "builder" && <Builder key={agent.id} agent={agent} types={types} onSaved={refresh} />}
              {tab === "conversations" && <Conversations agent={agent} />}
              {tab === "runs" && <Runs agent={agent} types={types} />}
              {tab === "knowledge" && <Knowledge agent={agent} />}
              {tab === "channels" && <Channels agent={agent} />}
              {tab === "settings" && (
                <Settings
                  agent={agent}
                  onSaved={refresh}
                  onDeleted={async () => {
                    setSelected(null);
                    await refresh();
                  }}
                />
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

const EXAMPLES = [
  "בוט וואטסאפ למספרה שקובע תורים ביומן גוגל, עונה על מחירים ושולח לי הודעה בטלגרם על כל תור חדש",
  "A Telegram bot for a yoga studio that answers class questions, collects leads into Google Sheets and hands off to me when someone wants a private session",
  "When my Shopify store sends a new order webhook, log it to Sheets, email the customer, and alert me on Telegram if the order is above $300",
];

function Designer({ onDesigned }: { onDesigned: (id: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ notes: string[]; designer: string } | null>(null);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ agent: Agent; notes: string[]; designer: string }>("/api/agents/design", { method: "POST", json: { prompt } });
      setResult(r);
      onDesigned(r.agent.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card designer">
      <div className="card-title">✨ Describe your bot, Claude builds it</div>
      <p className="muted small">Write in Hebrew or English what the bot should do, on which channels, and what should happen behind the scenes. Claude designs the flow, the persona and a starter knowledge base, then validates and repairs its own draft.</p>
      <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={EXAMPLES[0]} dir="auto" />
      <div className="row">
        {EXAMPLES.map((ex, i) => (
          <button key={i} className="ghost small" onClick={() => setPrompt(ex)}>
            Example {i + 1}
          </button>
        ))}
        <span className="spacer" />
        <button className="primary" disabled={busy || prompt.trim().length < 10} onClick={go}>
          {busy ? "Designing…" : "Build with AI"}
        </button>
      </div>
      {error && <div className="status err">{error}</div>}
      {result?.notes?.length ? (
        <ul className="small">
          {result.notes.map((n, i) => (
            <li key={i} dir="auto">
              {n}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Home({ templates, agents, onCreate, onOpen, onDesigned }: { templates: Template[]; agents: Agent[]; onCreate: (t?: string) => void; onOpen: (id: string) => void; onDesigned: (id: string) => void }) {
  const totals = agents.reduce(
    (s, a) => ({ runs: s.runs + (a.stats?.runs ?? 0), contacts: s.contacts + (a.stats?.contacts ?? 0), handoffs: s.handoffs + (a.stats?.handoffs ?? 0) }),
    { runs: 0, contacts: 0, handoffs: 0 },
  );
  return (
    <div className="home">
      <h1>Build AI agents that talk on WhatsApp, Telegram and the web, and automate the work behind them.</h1>
      <p className="muted">Design a flow visually, give a Claude agent tools (Sheets, Calendar, Gmail, your APIs, knowledge base), connect channels, and watch every run step by step.</p>
      <div className="stats">
        <Stat label="Agents" value={agents.length} />
        <Stat label="Contacts" value={totals.contacts} />
        <Stat label="Runs" value={totals.runs} />
        <Stat label="Human handoffs" value={totals.handoffs} />
      </div>
      <Designer onDesigned={onDesigned} />
      <h3>Or start from a template</h3>
      <div className="cards">
        {templates.map((t) => (
          <div key={t.id} className="card">
            <div className="card-title" dir="auto">
              {t.name}
            </div>
            <p className="muted small">{t.description}</p>
            <div className="row">
              <span className="pill">{t.language === "he" ? "עברית" : "English"}</span>
              <span className="pill">{t.nodes} nodes</span>
              <span className="spacer" />
              <button className="primary" onClick={() => onCreate(t.id)}>
                Use template
              </button>
            </div>
          </div>
        ))}
        <div className="card dashed">
          <div className="card-title">Blank agent</div>
          <p className="muted small">Start with a single message trigger and build your own flow.</p>
          <button onClick={() => onCreate()}>Create blank</button>
        </div>
      </div>
      {agents.length > 0 && (
        <>
          <h3>Your agents</h3>
          <div className="cards">
            {agents.map((a) => (
              <div key={a.id} className="card clickable" onClick={() => onOpen(a.id)}>
                <div className="card-title" dir="auto">
                  {a.name}
                </div>
                <div className="muted small">
                  {a.flow.nodes.length} nodes · {a.stats?.runs ?? 0} runs · avg {a.stats?.avgMs ?? 0} ms
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
