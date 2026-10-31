// Shared inbox across agents, and plain-language explanations of where each agent reply came from.
import type { Agent, RunRecord, Session } from "./engine/types.js";
import type { KbDoc } from "./db.js";
import { getNodeDef } from "./engine/registry.js";

export type InboxFilter = "waiting" | "handled" | "all";

export interface InboxItem {
  id: string;
  agentId: string;
  agentName: string;
  channel: string;
  contactName: string;
  lastText: string;
  lastAt: string;
  handoff: boolean;
  /** When the agent handed the chat to a person (ISO), if it did. */
  handedAt?: string;
  messages: number;
}

const TEAM = /^\[team\] /;

export function toItem(s: Session, agents: Map<string, Agent>): InboxItem {
  const last = s.history.at(-1);
  const lastUser = [...s.history].reverse().find((h) => h.role === "user");
  return {
    id: s.id,
    agentId: s.agentId,
    agentName: agents.get(s.agentId)?.name ?? "Deleted agent",
    channel: s.channel,
    contactName: s.contactName || s.contactId,
    // For a waiting chat the customer's last words matter more than the agent's holding reply.
    lastText: ((s.handoff ? lastUser : last) ?? last)?.text.replace(TEAM, "") ?? "",
    lastAt: last?.at ?? s.updatedAt,
    handoff: s.handoff,
    handedAt: s.handoff ? (s.vars.__brief?.at ?? last?.at ?? s.updatedAt) : undefined,
    messages: s.history.length,
  };
}

export function matches(i: InboxItem, filter: InboxFilter) {
  if (filter === "waiting") return i.handoff;
  if (filter === "handled") return !i.handoff && i.messages > 0;
  return true;
}

/** Waiting chats oldest first (who has waited longest), everything else newest first. */
export function sortItems(items: InboxItem[], filter: InboxFilter) {
  return filter === "waiting"
    ? items.sort((a, b) => (a.handedAt ?? a.lastAt).localeCompare(b.handedAt ?? b.lastAt))
    : items.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export interface Explanation {
  /** Index into session.history of the agent message this explains. */
  index: number;
  source: "knowledge" | "step" | "ai" | "handoff" | "team";
  /** Short sentence for the inbox, e.g. "Answered from the Prices note". */
  summary: string;
  doc?: { id: string; title: string; quote: string };
  query?: string;
  tools?: string[];
  nodeId?: string;
}

const clip = (s: string, n = 180) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** The paragraph of a knowledge chunk that shares the most words with the query (falls back to the start). */
export function bestPassage(snippet: string, query: string) {
  const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const q = words(query);
  const parts = snippet.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  let best = parts[0] ?? snippet;
  let bestScore = 0;
  for (const part of parts) {
    const w = words(part);
    const score = [...q].filter((t) => [...w].some((x) => x === t || (t.length > 3 && x.startsWith(t)))).length;
    if (score > bestScore) [best, bestScore] = [part, score];
  }
  return clip(best);
}

function parse(v: unknown): any {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/**
 * Explains each agent message in a conversation by matching it to the run step that produced it.
 * Knowledge answers name the note and quote the passage the agent read, so staff can fix the source.
 */
export function explainSession(session: Session, runs: RunRecord[], docs: KbDoc[], agent?: Agent): Explanation[] {
  const docByTitle = new Map(docs.map((d) => [d.title.trim().toLowerCase(), d]));
  const nodes = new Map((agent?.flow.nodes ?? []).map((n) => [n.id, n]));
  const out: Explanation[] = [];
  const used = new Set<string>();

  session.history.forEach((h, index) => {
    if (h.role !== "assistant") return;
    if (TEAM.test(h.text)) {
      out.push({ index, source: "team", summary: "Sent by your team" });
      return;
    }
    for (const run of runs) {
      for (const step of run.steps) {
        const key = `${run.id}:${step.nodeId}:${step.startedAt}`;
        if (used.has(key) || step.output?.text !== h.text) continue;
        used.add(key);
        const node = nodes.get(step.nodeId);
        const name = node?.label || getNodeDef(node?.type ?? "")?.label || "a step";
        if (step.type === "ai.agent") {
          const calls: { name: string; input: any; result: any }[] = step.output?.toolCalls ?? [];
          const tools = calls.map((c) => c.name);
          if (step.port === "handoff" || tools.includes("handoff_to_human")) {
            out.push({ index, source: "handoff", summary: "The agent handed this conversation to your team", tools, nodeId: step.nodeId });
            return;
          }
          const kb = calls.filter((c) => c.name === "knowledge_search");
          for (const c of kb) {
            const hit = parse(c.result)?.results?.[0];
            if (!hit?.title) continue;
            const doc = docByTitle.get(String(hit.title).trim().toLowerCase());
            out.push({
              index,
              source: "knowledge",
              summary: `Answered from the ${hit.title} note`,
              doc: doc ? { id: doc.id, title: doc.title, quote: bestPassage(String(hit.snippet ?? ""), String(c.input?.query ?? "")) } : undefined,
              query: String(c.input?.query ?? ""),
              tools,
              nodeId: step.nodeId,
            });
            return;
          }
          out.push({
            index,
            source: "ai",
            summary: kb.length ? "Written by Claude. The knowledge base had no match" : "Written by Claude without the knowledge base",
            query: kb[0] ? String(kb[0].input?.query ?? "") : undefined,
            tools,
            nodeId: step.nodeId,
          });
          return;
        }
        out.push({ index, source: "step", summary: `Fixed message from the step "${name}"`, nodeId: step.nodeId });
        return;
      }
    }
  });
  return out;
}
