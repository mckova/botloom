import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, CHANNELS, type Explanation, type InboxData, type InboxItem, type KbDoc, type SessionDetail } from "../api";

export type Folder = { kind: "waiting" | "handled" | "all" } | { kind: "agent"; id: string } | { kind: "channel"; id: string };

const channelName = (c: string) => CHANNELS[c] ?? c;

/** "12 min", "3 h", "2 d": how long, for a list that is read at a glance. */
export function since(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}
const clock = (iso: string) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${t}`;
};
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const firstName = (n: string) => n.split(/\s+/)[0] || n;
const TEAM = /^\[team\] /;

function query(folder: Folder) {
  if (folder.kind === "agent") return `?filter=all&agent=${encodeURIComponent(folder.id)}`;
  if (folder.kind === "channel") return `?filter=all&channel=${encodeURIComponent(folder.id)}`;
  return `?filter=${folder.kind}`;
}

export default function Inbox({
  folder,
  onFolder,
  selected,
  onSelect,
  search,
  onOpenAgent,
}: {
  folder: Folder;
  onFolder: (f: Folder) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  search: string;
  onOpenAgent: (id: string) => void;
}) {
  const [data, setData] = useState<InboxData | null>(null);
  // Narrow screens show the list or the conversation, one at a time.
  const [opened, setOpened] = useState(false);
  const load = useCallback(() => api<InboxData>(`/api/inbox${query(folder)}`).then(setData), [folder]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = data?.items ?? [];
    return q ? all.filter((i) => `${i.contactName} ${i.lastText} ${i.agentName}`.toLowerCase().includes(q)) : all;
  }, [data, search]);

  // Keep a conversation open: the first one in the list when nothing is chosen or the choice left the folder.
  useEffect(() => {
    if (!data) return;
    if (!selected && items[0]) onSelect(items[0].id);
  }, [data, items, selected, onSelect]);

  const pick = (f: Folder) => {
    setOpened(false);
    onFolder(f);
  };
  const c = data?.counts;
  const isOn = (f: Folder) => f.kind === folder.kind && ("id" in f ? "id" in folder && folder.id === f.id : true);
  const title =
    folder.kind === "waiting" ? "Waiting for you" : folder.kind === "handled" ? "Handled by agents" : folder.kind === "all" ? "All conversations" : folder.kind === "agent" ? (c?.agents.find((a) => a.id === folder.id)?.name ?? "Agent") : channelName((folder as { id: string }).id);
  const sub =
    folder.kind === "waiting"
      ? items.length === 1
        ? "1 person, waiting"
        : `${items.length} people, oldest first`
      : `${items.length} ${items.length === 1 ? "conversation" : "conversations"}, newest first`;

  return (
    <div className="inbox" data-opened={opened}>
      <nav className="glass col folders" aria-label="Inbox folders">
        <div className="k">Inbox</div>
        <FolderLink on={isOn({ kind: "waiting" })} onClick={() => pick({ kind: "waiting" })} label="Waiting for you" n={c?.waiting} />
        <FolderLink on={isOn({ kind: "handled" })} onClick={() => pick({ kind: "handled" })} label="Handled by agents" n={c?.handled} />
        <FolderLink on={isOn({ kind: "all" })} onClick={() => pick({ kind: "all" })} label="All" n={c?.all} />
        <div className="k gap">Agents</div>
        {c?.agents.map((a) => (
          <FolderLink key={a.id} on={isOn({ kind: "agent", id: a.id })} onClick={() => pick({ kind: "agent", id: a.id })} label={a.name} n={a.waiting || undefined} bidi />
        ))}
        {c && c.channels.length > 0 && <div className="k gap">Channels</div>}
        {c?.channels.map((ch) => (
          <FolderLink key={ch.id} on={isOn({ kind: "channel", id: ch.id })} onClick={() => pick({ kind: "channel", id: ch.id })} label={channelName(ch.id)} n={ch.waiting || undefined} />
        ))}
      </nav>

      <section className="glass col conv-list" aria-labelledby="list-title">
        <h1 id="list-title" className="ttl" dir="auto">
          {title}
        </h1>
        <p className="sub">{data ? sub : " "}</p>
        <div className="rows">
          {data && items.length === 0 && (
            <div className="quiet">
              {search ? (
                <p>No conversation matches “{search}”.</p>
              ) : folder.kind === "waiting" ? (
                <>
                  <b>Nothing is waiting for you</b>
                  <p>When an agent hands a conversation to your team, it appears here with a brief from Claude.</p>
                </>
              ) : (
                <p>No conversations yet.</p>
              )}
            </div>
          )}
          {items.map((i) => (
            <Row key={i.id} item={i} on={i.id === selected} onClick={() => { setOpened(true); onSelect(i.id); }} />
          ))}
        </div>
      </section>

      {selected ? <Conversation key={selected} id={selected} onChanged={load} onOpenAgent={onOpenAgent} onBack={() => setOpened(false)} /> : <div className="glass cv empty-cv" />}
    </div>
  );
}

function FolderLink({ on, onClick, label, n, bidi }: { on: boolean; onClick: () => void; label: string; n?: number; bidi?: boolean }) {
  return (
    <button className={`f ${on ? "on" : ""}`} onClick={onClick} aria-current={on ? "page" : undefined}>
      <span className="truncate" dir={bidi ? "auto" : undefined}>
        {label}
      </span>
      <span className="n">{n ?? ""}</span>
    </button>
  );
}

function Row({ item, on, onClick }: { item: InboxItem; on: boolean; onClick: () => void }) {
  return (
    <button className={`row ${on ? "on" : ""}`} onClick={onClick} aria-current={on ? "true" : undefined}>
      <span className="a">
        <b className="truncate" dir="auto">
          {item.contactName}
        </b>
        <span className="tm">{since(item.handoff ? (item.handedAt ?? item.lastAt) : item.lastAt)}</span>
      </span>
      <span className="p" dir="auto">
        {item.lastText}
      </span>
      <span className="v">
        <span dir="auto">{item.agentName}</span> · {channelName(item.channel)}
      </span>
    </button>
  );
}

type Sheet = { kind: "edit"; doc: KbDoc } | { kind: "teach"; question: string; answer: string } | null;

function Conversation({ id, onChanged, onOpenAgent, onBack }: { id: string; onChanged: () => void; onOpenAgent: (id: string) => void; onBack: () => void }) {
  const [s, setS] = useState<SessionDetail | null>(null);
  const [why, setWhy] = useState<Explanation[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "draft" | "release">("");
  const [sheet, setSheet] = useState<Sheet>(null);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [detail, ex] = await Promise.all([api<SessionDetail>(`/api/sessions/${id}`), api<Explanation[]>(`/api/sessions/${id}/explain`)]);
    setS(detail);
    setWhy(ex);
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  const count = s?.history.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  if (!s) return <div className="glass cv" aria-busy="true" />;

  const name = s.contactName || s.contactId;
  const whyAt = new Map(why.map((w) => [w.index, w]));
  const handedAt = s.handoff ? (s.brief?.at ?? s.updatedAt) : null;
  // The system line goes after the last message sent before the handoff.
  const handIndex = handedAt ? s.history.reduce((acc, h, i) => (h.at <= handedAt ? i : acc), s.history.length - 1) : -1;

  const send = async (release: boolean) => {
    if (!text.trim()) {
      toast("Write a reply first.");
      return;
    }
    setBusy("send");
    try {
      const r = await api<{ delivery?: { delivered: boolean; detail?: string } }>(`/api/sessions/${id}/reply`, { method: "POST", json: { text } });
      if (release) await api(`/api/sessions/${id}/release`, { method: "POST" });
      setText("");
      const handed = release ? ` ${s.agentName} has the conversation again.` : "";
      if (r.delivery && !r.delivery.delivered) toast.warning(`Saved in the conversation, but not delivered: ${r.delivery.detail ?? "the channel refused it"}.${handed}`);
      else toast(`Sent.${handed}`);
      await load();
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const handBack = async () => {
    setBusy("release");
    await api(`/api/sessions/${id}/release`, { method: "POST" });
    toast(`${s.agentName} has the conversation again.`);
    await load();
    onChanged();
    setBusy("");
  };
  const draft = async () => {
    setBusy("draft");
    try {
      const r = await api<{ draft: string }>(`/api/sessions/${id}/suggest`, { method: "POST" });
      setText(r.draft);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const openNote = async (docId: string) => {
    const docs = await api<KbDoc[]>(`/api/agents/${s.agentId}/docs`);
    const doc = docs.find((d) => d.id === docId);
    if (doc) setSheet({ kind: "edit", doc });
    else toast("That note was deleted.");
  };
  const teach = (index: number) => {
    const question = [...s.history.slice(0, index)].reverse().find((h) => h.role === "user")?.text ?? "";
    setSheet({ kind: "teach", question, answer: s.history[index].text });
  };

  return (
    <>
      <section className="glass cv" aria-label={`Conversation with ${name}`}>
        <header className="ch">
          <button className="btn t back" onClick={onBack}>
            Back
          </button>
          <div className="min0">
            <h2 className="truncate" dir="auto">
              {name}
            </h2>
            <div className="v">
              {channelName(s.channel)} · {s.handoff ? `waiting ${since(handedAt!)}` : `handled by ${s.agentName}`}
            </div>
          </div>
          <span className="spacer" />
          {s.handoff && (
            <button className="btn q" onClick={handBack} disabled={busy === "release"}>
              Hand back to agent
            </button>
          )}
        </header>

        <div className="ms">
          {s.history.map((h, i) => {
            const team = TEAM.test(h.text);
            const w = whyAt.get(i);
            return (
              <div key={i} className="mwrap">
                <div className={`m ${h.role === "user" ? "in" : "out"}`}>
                  {h.role === "assistant" && <div className="w" dir="auto">{team ? "Your team" : s.agentName}</div>}
                  <div className="b" dir="auto">
                    {h.text.replace(TEAM, "")}
                    {w && (w.source === "knowledge" || w.source === "ai") && (
                      <div className="why" dir="ltr">
                        {w.summary}
                        {w.doc && <q dir="auto">{w.doc.quote}</q>}
                        {!w.doc && <span className="br" />}
                        {w.doc && (
                          <button className="lnk" onClick={() => openNote(w.doc!.id)}>
                            Edit this note
                          </button>
                        )}
                        <button className="lnk" onClick={() => teach(i)}>
                          Teach a better answer
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {i === handIndex && <div className="sys">Handed to you at {clock(handedAt!)}</div>}
              </div>
            );
          })}
          <div ref={end} />
        </div>

        <div className="cp">
          <label htmlFor="reply" className="sr-only">
            Reply to {name}
          </label>
          <textarea
            id="reply"
            dir="auto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(s.handoff);
            }}
            placeholder={`Write a reply to ${firstName(name)}`}
            rows={2}
          />
          <div className="r">
            <button className="btn t" onClick={draft} disabled={busy === "draft"} aria-busy={busy === "draft"}>
              {busy === "draft" ? "Drafting…" : "Draft with Claude"}
            </button>
            <span className="spacer" />
            {s.handoff && (
              <button className="btn t" onClick={() => send(false)} disabled={busy === "send"}>
                Send only
              </button>
            )}
            <button className="btn d" onClick={() => send(s.handoff)} disabled={busy === "send"} aria-busy={busy === "send"}>
              {s.handoff ? "Send and hand back" : "Send"}
            </button>
          </div>
        </div>

        {sheet && (
          <NoteSheet
            sheet={sheet}
            agentId={s.agentId}
            onClose={() => setSheet(null)}
            onSaved={() => {
              setSheet(null);
              load();
            }}
          />
        )}
      </section>

      <aside className="glass col side" aria-label="About this conversation">
        {s.brief ? (
          <>
            <h3>{s.brief.by === "claude" ? "Brief from Claude" : "Brief"}</h3>
            <p className="brief-text" dir="auto">
              {s.brief.summary}
            </p>
            <p className="ns" dir="auto">
              Next step: {s.brief.nextStep}
            </p>
            {s.brief.by === "rules" && <p className="ns note">Written by the rule-based fallback because Claude was not available.</p>}
          </>
        ) : (
          <>
            <h3>Brief</h3>
            <p className="ns">{s.handoff ? "Claude is writing the brief." : `${s.agentName} handled this conversation without your team.`}</p>
          </>
        )}

        <h3>Contact</h3>
        <dl className="dl">
          <dt>{s.channel === "whatsapp" ? "Phone" : "Contact ID"}</dt>
          <dd className="truncate">{s.channel === "whatsapp" ? `+${s.contactId.replace(/^\+/, "")}` : s.contactId}</dd>
          <dt>First seen</dt>
          <dd>{day(s.firstSeen)}</dd>
          <dt>History</dt>
          <dd>{s.history.length === 1 ? "1 message" : `${s.history.length} messages`}</dd>
          <dt>Agent</dt>
          <dd>
            <button className="lnk plain" dir="auto" onClick={() => onOpenAgent(s.agentId)}>
              {s.agentName}
            </button>
          </dd>
        </dl>

        <h3>Remembered by the agent</h3>
        {s.memory.length === 0 ? (
          <p className="ns">Nothing yet. The agent saves preferences the customer shares.</p>
        ) : (
          <div className="mem">
            {s.memory.map((m) => (
              <div key={m.id}>
                <span dir="auto">{m.fact}</span>
                <button
                  className="lnk forget"
                  onClick={async () => {
                    await api(`/api/sessions/${id}/memory/${m.id}`, { method: "DELETE" });
                    load();
                  }}
                  aria-label={`Forget: ${m.fact}`}
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}

function NoteSheet({ sheet, agentId, onClose, onSaved }: { sheet: NonNullable<Sheet>; agentId: string; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState(sheet.kind === "edit" ? sheet.doc.title : sheet.question);
  const [b, setB] = useState(sheet.kind === "edit" ? sheet.doc.content : sheet.answer);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const save = async () => {
    if (!a.trim() || !b.trim()) {
      toast("Both fields are needed.");
      return;
    }
    setBusy(true);
    try {
      if (sheet.kind === "edit") await api(`/api/docs/${sheet.doc.id}`, { method: "PUT", json: { title: a, content: b } });
      else await api(`/api/agents/${agentId}/teach`, { method: "POST", json: { question: a, answer: b } });
      toast(sheet.kind === "edit" ? "Note saved. The agent uses it from the next message." : "Saved. The agent will answer this way from now on.");
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="sheet-in">
        <h2 id="sheet-h">{sheet.kind === "edit" ? "Edit note" : "Teach a better answer"}</h2>
        <p className="ns">
          {sheet.kind === "edit"
            ? "The agent searches this note before answering. Changes apply to the next message."
            : "Saved as a correction note in the agent's knowledge. The agent finds it the next time someone asks."}
        </p>
        <label className="fld">
          <span>{sheet.kind === "edit" ? "Title" : "When a customer asks"}</span>
          <input dir="auto" value={a} onChange={(e) => setA(e.target.value)} />
        </label>
        <label className="fld grow">
          <span>{sheet.kind === "edit" ? "Note" : "Answer"}</span>
          <textarea ref={first} dir="auto" value={b} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && save()} />
        </label>
        <div className="r">
          <span className="spacer" />
          <button className="btn t" onClick={onClose}>
            Cancel
          </button>
          <button className="btn d" onClick={save} disabled={busy} aria-busy={busy}>
            {sheet.kind === "edit" ? "Save note" : "Save answer"}
          </button>
        </div>
      </div>
    </div>
  );
}
