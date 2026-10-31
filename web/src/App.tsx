import { useEffect, useState, useCallback } from "react";
import { Toaster } from "sonner";
import { api, type Agent, type NodeType } from "./api";
import Builder from "./views/Builder";
import Inbox, { type Folder } from "./views/Inbox";
import Runs from "./views/Runs";
import Knowledge from "./views/Knowledge";
import Channels from "./views/Channels";
import Settings from "./views/Settings";

type Page = "inbox" | "agents" | "knowledge" | "reports";
type Tab = "builder" | "runs" | "knowledge" | "channels" | "settings";
const PAGES: { id: Page; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "agents", label: "Agents" },
  { id: "knowledge", label: "Knowledge" },
  { id: "reports", label: "Reports" },
];
const TABS: { id: Tab; label: string }[] = [
  { id: "builder", label: "Flow" },
  { id: "runs", label: "Runs" },
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

const pluralRules = new Intl.PluralRules("en");
export const plural = (n: number, word: string) => `${n.toLocaleString()} ${pluralRules.select(n) === "one" ? word : `${word}s`}`;

/** Absolute date after a week, relative before that. */
export function when(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Routes: #inbox/<session>, #agents/<agent>/<tab>, #knowledge/<agent>, #reports. */
function readHash() {
  const [page, a, b] = location.hash.slice(1).split("/");
  return { page: (PAGES.some((p) => p.id === page) ? page : "inbox") as Page, a: a || null, b: b || null };
}

export default function App() {
  const initial = readHash();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [types, setTypes] = useState<NodeType[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [health, setHealth] = useState<{ llm: string; google: string } | null>(null);
  const [page, setPage] = useState<Page>(initial.page);
  const [session, setSession] = useState<string | null>(initial.page === "inbox" ? initial.a : null);
  const [folder, setFolder] = useState<Folder>({ kind: "waiting" });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(initial.page !== "inbox" ? initial.a : null);
  const [tab, setTab] = useState<Tab>(() => ((initial.page === "agents" && (initial.b as Tab)) || "builder"));

  const refresh = useCallback(async () => setAgents(await api<Agent[]>("/api/agents")), []);
  useEffect(() => {
    refresh();
    api<NodeType[]>("/api/node-types").then(setTypes);
    api<Template[]>("/api/templates").then(setTemplates);
    api("/api/health").then(setHealth);
  }, [refresh]);

  const agent = agents.find((a) => a.id === selected);
  // The knowledge page always shows one agent's notes; default to the first agent.
  const kbAgent = agent ?? agents[0];
  useEffect(() => {
    const h = page === "inbox" ? `inbox${session ? `/${session}` : ""}` : page === "agents" ? `agents${selected ? `/${selected}/${tab}` : ""}` : page === "knowledge" ? `knowledge${selected ? `/${selected}` : ""}` : "reports";
    history.replaceState(null, "", `#${h}`);
    document.title = `${page === "agents" && agent ? agent.name : PAGES.find((p) => p.id === page)!.label} · BotLoom`;
  }, [page, session, selected, tab, agent]);

  const create = async (templateId?: string) => {
    const a = templateId
      ? await api<Agent>(`/api/agents/from-template/${templateId}`, { method: "POST" })
      : await api<Agent>("/api/agents", {
          method: "POST",
          json: { name: "Untitled agent", description: "", flow: { nodes: [{ id: "start", type: "trigger.message", position: { x: 0, y: 0 }, config: {} }], edges: [] }, settings: { language: "en" } },
        });
    await refresh();
    openAgent(a.id);
  };
  const openAgent = (id: string | null, t: Tab = "builder") => {
    setPage("agents");
    setSelected(id);
    setTab(t);
  };

  return (
    <>
      <div className="shell">
        <header className="top">
          <button className="wm" onClick={() => setPage("inbox")}>
            BotLoom
          </button>
          <nav className="nav" aria-label="Main">
            {PAGES.map((p) => (
              <button key={p.id} className={page === p.id ? "on" : ""} aria-current={page === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
                {p.label}
              </button>
            ))}
          </nav>
          <label className="search glass">
            <span className="sr-only">Search conversations</span>
            <input
              type="search"
              placeholder="Search conversations"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (page !== "inbox") setPage("inbox");
                if (folder.kind !== "all" && e.target.value) setFolder({ kind: "all" });
              }}
            />
          </label>
          <span className="user" title={health?.google === "live" ? "Google connected" : "Google calls run in a logged sandbox"}>
            {health ? (health.llm === "mock" ? "Demo provider" : "Claude Opus 5.5") : ""}
          </span>
        </header>

        {page === "inbox" && (
          <Inbox
            folder={folder}
            onFolder={(f) => {
              setFolder(f);
              setSession(null);
            }}
            selected={session}
            onSelect={setSession}
            search={search}
            onOpenAgent={(id) => openAgent(id)}
          />
        )}

        {page === "agents" && (
          <div className="two">
            <nav className="glass col folders" aria-label="Agents">
              <div className="k">Agents</div>
              <button className={`f ${!agent ? "on" : ""}`} onClick={() => setSelected(null)} aria-current={!agent ? "page" : undefined}>
                <span>New agent</span>
                <span className="n" />
              </button>
              <div className="k gap">Your agents</div>
              {agents.map((a) => (
                <button key={a.id} className={`f ${a.id === selected ? "on" : ""}`} onClick={() => setSelected(a.id)} aria-current={a.id === selected ? "page" : undefined}>
                  <span className="truncate" dir="auto">
                    {a.name}
                  </span>
                  <span className="n">{a.stats?.runs || ""}</span>
                </button>
              ))}
            </nav>
            <main className="glass panel">
              {!agent ? (
                <Workspace templates={templates} agents={agents} llm={health?.llm} onCreate={create} onOpen={(id) => openAgent(id)} onDesigned={async (id) => {
                  await refresh();
                  openAgent(id);
                }} />
              ) : (
                <>
                  <header className="ph">
                    <h1 className="truncate" dir="auto">
                      {agent.name}
                    </h1>
                    <nav className="tabs" aria-label="Agent sections">
                      {TABS.map((t) => (
                        <button key={t.id} className={tab === t.id ? "on" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
                          {t.label}
                        </button>
                      ))}
                    </nav>
                  </header>
                  <section className="content">
                    {tab === "builder" && <Builder key={agent.id} agent={agent} types={types} onSaved={refresh} />}
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
        )}

        {page === "knowledge" && (
          <div className="two">
            <nav className="glass col folders" aria-label="Knowledge by agent">
              <div className="k">Knowledge</div>
              {agents.map((a) => (
                <button key={a.id} className={`f ${a.id === kbAgent?.id ? "on" : ""}`} onClick={() => setSelected(a.id)} aria-current={a.id === kbAgent?.id ? "page" : undefined}>
                  <span className="truncate" dir="auto">
                    {a.name}
                  </span>
                  <span className="n" />
                </button>
              ))}
            </nav>
            <main className="glass panel">
              <section className="content">{kbAgent ? <Knowledge key={kbAgent.id} agent={kbAgent} /> : <p className="quiet">Create an agent first.</p>}</section>
            </main>
          </div>
        )}

        {page === "reports" && (
          <main className="glass panel">
            <section className="content">
              <Reports agents={agents} onOpen={(id) => openAgent(id, "runs")} />
            </section>
          </main>
        )}
      </div>
      <Toaster position="bottom-right" toastOptions={{ className: "toast" }} />
    </>
  );
}

function Reports({ agents, onOpen }: { agents: Agent[]; onOpen: (id: string) => void }) {
  const sum = (k: "runs" | "handoffs" | "contacts" | "failed") => agents.reduce((n, a) => n + (a.stats?.[k] ?? 0), 0);
  const runs = sum("runs");
  const handoffs = sum("handoffs");
  return (
    <div className="page wide">
      <h1>Reports</h1>
      <p className="lede">Counted from every run your agents have made. A run is one message or trigger handled end to end.</p>
      <dl className="totals">
        <div>
          <dt>Conversations</dt>
          <dd>{sum("contacts").toLocaleString()}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{runs.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Handled without your team</dt>
          <dd>{runs ? `${Math.round(((runs - handoffs) / runs) * 100)}%` : "-"}</dd>
        </div>
        <div>
          <dt>Failed runs</dt>
          <dd>{sum("failed").toLocaleString()}</dd>
        </div>
      </dl>
      <table className="grid">
        <thead>
          <tr>
            <th>Agent</th>
            <th className="n">Conversations</th>
            <th className="n">Runs</th>
            <th className="n">Handoffs</th>
            <th className="n">Failed</th>
            <th className="n">Avg run</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} onClick={() => onOpen(a.id)}>
              <td>
                <button className="lnk plain" dir="auto" onClick={() => onOpen(a.id)}>
                  {a.name}
                </button>
              </td>
              <td className="n">{a.stats?.contacts ?? 0}</td>
              <td className="n">{a.stats?.runs ?? 0}</td>
              <td className="n">{a.stats?.handoffs ?? 0}</td>
              <td className="n">{a.stats?.failed ?? 0}</td>
              <td className="n">{a.stats?.runs ? `${a.stats.avgMs} ms` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TRIES = [
  "בוט וואטסאפ למספרה: קובע תורים ביומן גוגל לפי שעות פנויות, עונה על מחירים ושולח לי הודעה בטלגרם על כל תור חדש",
  "Telegram bot for a yoga studio. Answers class questions, saves trial-class leads to Google Sheets, hands off private-session requests to me.",
  "When Shopify sends a new order webhook: log it to Sheets, email the customer a personal thank-you, and alert me on Slack if the total is over $300.",
];

function Composer({ llm, onDesigned }: { llm?: string; onDesigned: (id: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const go = async () => {
    if (prompt.trim().length < 10) {
      setError("Write a sentence or two about who the agent talks to and what it should do.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{ agent: Agent; notes: string[] }>("/api/agents/design", { method: "POST", json: { prompt } });
      setNotes(r.notes);
      onDesigned(r.agent.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="composer">
        <label htmlFor="composer" className="sr-only">
          Describe a new agent
        </label>
        <textarea
          id="composer"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim().length >= 10) go();
          }}
          placeholder="Describe the agent you need: who it talks to, on which channel, and what should happen behind the scenes."
          dir="auto"
        />
        <div className="composer-foot">
          <span className="soft">
            {llm === "mock" ? "Demo provider: picks the closest working example. Add an Anthropic key for custom designs." : "Claude drafts the flow, persona and knowledge base, checks the graph, and fixes its own draft."}
          </span>
          <span className="spacer" />
          <span className="kbd" aria-hidden="true">
            ⌘
          </span>
          <span className="kbd" aria-hidden="true">
            ↵
          </span>
          <button className="primary" disabled={busy} onClick={go} aria-busy={busy}>
            {busy ? "Designing…" : "Design agent"}
          </button>
        </div>
      </div>
      {error && (
        <div className="status err" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="notes" aria-live="polite">
          {notes.map((n, i) => (
            <li key={i} dir="auto">
              {n}
            </li>
          ))}
        </ul>
      )}
      <div className="tries">
        {TRIES.map((t) => (
          <button key={t} className="link truncate" onClick={() => setPrompt(t)} dir="auto" title={t}>
            {t}
          </button>
        ))}
      </div>
    </>
  );
}

const startsOn = (a: Agent) => {
  const kinds = new Set(a.flow.nodes.map((n) => n.type));
  return [kinds.has("trigger.message") && "Chat", kinds.has("trigger.webhook") && "Webhook", kinds.has("trigger.schedule") && "Schedule"].filter(Boolean).join(", ") || "None";
};

function Workspace({
  templates,
  agents,
  llm,
  onCreate,
  onOpen,
  onDesigned,
}: {
  templates: Template[];
  agents: Agent[];
  llm?: string;
  onCreate: (t?: string) => void;
  onOpen: (id: string) => void;
  onDesigned: (id: string) => void;
}) {
  const waiting = agents.reduce((n, a) => n + (a.stats?.handoffs ?? 0), 0);
  return (
    <div className="workspace">
      <div className="workspace-head">
        <h1>New agent</h1>
      </div>
      <Composer llm={llm} onDesigned={onDesigned} />

      <section className="block" aria-labelledby="agents-h">
        <div className="block-head">
          <h2 id="agents-h">Agents</h2>
          <p className="num">
            {plural(agents.length, "agent")}
            {waiting > 0 && ` · ${plural(waiting, "handoff")} so far`}
          </p>
          <span className="spacer" />
          <button className="sm" onClick={() => onCreate()}>
            Blank agent
          </button>
        </div>
        {agents.length === 0 ? (
          <div className="empty" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8 }}>
            <b>No agents yet</b>
            <span>Describe one above, or start from a working example below.</span>
          </div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Starts on</th>
                <th className="n">Contacts</th>
                <th className="n">Runs</th>
                <th className="n">Handoffs</th>
                <th className="n">Avg run</th>
                <th>Edited</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} onClick={() => onOpen(a.id)}>
                  <td>
                    <button className="link name" style={{ textDecoration: "none", color: "var(--ink)" }} dir="auto" onClick={() => onOpen(a.id)}>
                      {a.name}
                    </button>
                  </td>
                  <td className="soft">{startsOn(a)}</td>
                  <td className="n">{a.stats?.contacts ?? 0}</td>
                  <td className="n">{a.stats?.runs ?? 0}</td>
                  <td className="n">{a.stats?.handoffs ?? 0}</td>
                  <td className="n">{a.stats?.runs ? `${a.stats.avgMs} ms` : "-"}</td>
                  <td className="soft">{when(a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="block" aria-labelledby="examples-h">
        <div className="block-head">
          <h2 id="examples-h">Working examples</h2>
          <p>They run end to end in demo mode, without API keys.</p>
        </div>
        <div className="examples">
          {templates.map((t) => (
            <div key={t.id} className="example">
              <div>
                <h3 dir="auto">{t.name}</h3>
                <p>{t.description}</p>
                <div className="meta num">
                  <span>{t.language === "he" ? "Hebrew" : "English"}</span>
                  <span>{plural(t.nodes, "step")}</span>
                </div>
              </div>
              <button onClick={() => onCreate(t.id)}>Use example</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
