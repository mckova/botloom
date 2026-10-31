// SQLite persistence (node:sqlite, built into Node 22+, no native build step).
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Agent, ChannelKind, RunRecord, Session } from "./engine/types.js";

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

export interface ChannelConfig {
  id: string;
  agentId: string;
  kind: ChannelKind;
  enabled: boolean;
  config: Record<string, any>; // tokens are stored here; never returned to the UI unmasked
}

export interface KbDoc {
  id: string;
  agentId: string;
  title: string;
  content: string;
  createdAt: string;
}

export interface IntegrationLog {
  id: number;
  agentId: string;
  service: string;
  action: string;
  mode: "live" | "sandbox";
  request: any;
  response: any;
  at: string;
}

const j = (v: unknown) => JSON.stringify(v ?? null);
const p = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export class Store {
  db: DatabaseSync;

  constructor(file = process.env.BOTLOOM_DB ?? "data/botloom.db") {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        flow TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT NOT NULL, contact_id TEXT NOT NULL,
        contact_name TEXT, vars TEXT NOT NULL, history TEXT NOT NULL, wait TEXT, handoff INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, UNIQUE(agent_id, channel, contact_id));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, trigger TEXT NOT NULL, status TEXT NOT NULL,
        steps TEXT NOT NULL, outbox TEXT NOT NULL, started_at TEXT NOT NULL, ms INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL, UNIQUE(agent_id, kind));
      CREATE TABLE IF NOT EXISTS kb_docs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, contact TEXT NOT NULL, fact TEXT NOT NULL, at TEXT NOT NULL,
        UNIQUE(agent_id, contact, fact));
      CREATE TABLE IF NOT EXISTS integration_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, service TEXT NOT NULL, action TEXT NOT NULL,
        mode TEXT NOT NULL, request TEXT, response TEXT, at TEXT NOT NULL);
    `);
  }

  // ---------- agents ----------
  private toAgent(r: any): Agent {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      flow: p(r.flow, { nodes: [], edges: [] }),
      settings: p(r.settings, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  listAgents(): Agent[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY updated_at DESC").all().map((r) => this.toAgent(r));
  }
  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return r ? this.toAgent(r) : undefined;
  }
  saveAgent(a: Omit<Agent, "createdAt" | "updatedAt"> & Partial<Agent>): Agent {
    const existing = this.getAgent(a.id);
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, flow, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, flow=excluded.flow,
         settings=excluded.settings, updated_at=excluded.updated_at`,
      )
      .run(a.id, a.name, a.description ?? "", j(a.flow), j(a.settings ?? {}), existing?.createdAt ?? ts, ts);
    return this.getAgent(a.id)!;
  }
  deleteAgent(id: string) {
    for (const t of ["sessions", "runs", "channels", "kb_docs", "integration_log", "contact_memory"])
      this.db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ---------- sessions ----------
  private toSession(r: any): Session {
    return {
      id: r.id,
      agentId: r.agent_id,
      channel: r.channel,
      contactId: r.contact_id,
      contactName: r.contact_name ?? undefined,
      vars: p(r.vars, {}),
      history: p(r.history, []),
      wait: p(r.wait, null),
      handoff: !!r.handoff,
      updatedAt: r.updated_at,
    };
  }
  getOrCreateSession(agentId: string, channel: ChannelKind, contactId: string, contactName?: string): Session {
    const r = this.db
      .prepare("SELECT * FROM sessions WHERE agent_id = ? AND channel = ? AND contact_id = ?")
      .get(agentId, channel, contactId);
    if (r) return this.toSession(r);
    const s: Session = {
      id: newId("ses"),
      agentId,
      channel,
      contactId,
      contactName,
      vars: {},
      history: [],
      wait: null,
      handoff: false,
      updatedAt: now(),
    };
    this.saveSession(s);
    return s;
  }
  getSession(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? this.toSession(r) : undefined;
  }
  saveSession(s: Session) {
    s.history = s.history.slice(-50);
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, channel, contact_id, contact_name, vars, history, wait, handoff, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contact_name=excluded.contact_name, vars=excluded.vars,
         history=excluded.history, wait=excluded.wait, handoff=excluded.handoff, updated_at=excluded.updated_at`,
      )
      .run(s.id, s.agentId, s.channel, s.contactId, s.contactName ?? null, j(s.vars), j(s.history), j(s.wait), s.handoff ? 1 : 0, now());
  }
  listSessions(agentId: string): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 200")
      .all(agentId)
      .map((r) => this.toSession(r));
  }
  deleteSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ---------- runs ----------
  saveRun(r: RunRecord) {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, session_id, trigger, status, steps, outbox, started_at, ms, error) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(r.id, r.agentId, r.sessionId, r.trigger, r.status, j(r.steps), j(r.outbox), r.startedAt, r.ms, r.error ?? null);
  }
  listRuns(agentId: string, limit = 50): RunRecord[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(agentId, limit)
      .map((r: any) => ({
        id: r.id,
        agentId: r.agent_id,
        sessionId: r.session_id,
        trigger: r.trigger,
        status: r.status,
        steps: p(r.steps, []),
        outbox: p(r.outbox, []),
        startedAt: r.started_at,
        ms: r.ms,
        error: r.error ?? undefined,
      }));
  }
  stats(agentId: string) {
    const row: any = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, SUM(status='failed') AS failed, SUM(status='handoff') AS handoffs, AVG(ms) AS avgMs FROM runs WHERE agent_id = ?`,
      )
      .get(agentId);
    const contacts: any = this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?").get(agentId);
    return {
      runs: Number(row.runs ?? 0),
      failed: Number(row.failed ?? 0),
      handoffs: Number(row.handoffs ?? 0),
      avgMs: Math.round(Number(row.avgMs ?? 0)),
      contacts: Number(contacts.n ?? 0),
    };
  }

  // ---------- channels ----------
  listChannels(agentId?: string): ChannelConfig[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM channels WHERE agent_id = ?").all(agentId)
      : this.db.prepare("SELECT * FROM channels").all();
    return rows.map((r: any) => ({ id: r.id, agentId: r.agent_id, kind: r.kind, enabled: !!r.enabled, config: p(r.config, {}) }));
  }
  getChannel(id: string): ChannelConfig | undefined {
    return this.listChannels().find((c) => c.id === id);
  }
  upsertChannel(agentId: string, kind: ChannelKind, config: Record<string, any>, enabled = true): ChannelConfig {
    const existing = this.listChannels(agentId).find((c) => c.kind === kind);
    const id = existing?.id ?? newId("ch");
    const merged = { ...(existing?.config ?? {}), ...config };
    this.db
      .prepare(
        `INSERT INTO channels (id, agent_id, kind, enabled, config) VALUES (?,?,?,?,?)
         ON CONFLICT(agent_id, kind) DO UPDATE SET enabled=excluded.enabled, config=excluded.config`,
      )
      .run(id, agentId, kind, enabled ? 1 : 0, j(merged));
    return this.getChannel(id)!;
  }

  // ---------- knowledge base ----------
  listDocs(agentId: string): KbDoc[] {
    return this.db
      .prepare("SELECT * FROM kb_docs WHERE agent_id = ? ORDER BY created_at")
      .all(agentId)
      .map((r: any) => ({ id: r.id, agentId: r.agent_id, title: r.title, content: r.content, createdAt: r.created_at }));
  }
  addDoc(agentId: string, title: string, content: string): KbDoc {
    const d = { id: newId("doc"), agentId, title, content, createdAt: now() };
    this.db.prepare("INSERT INTO kb_docs (id, agent_id, title, content, created_at) VALUES (?,?,?,?,?)").run(d.id, agentId, title, content, d.createdAt);
    return d;
  }
  deleteDoc(id: string) {
    this.db.prepare("DELETE FROM kb_docs WHERE id = ?").run(id);
  }

  // ---------- long-term contact memory ----------
  // Facts the agent chose to remember about a contact. They survive /restart and new sessions.
  listMemory(agentId: string, contact: string): { id: number; fact: string; at: string }[] {
    return this.db
      .prepare("SELECT id, fact, at FROM contact_memory WHERE agent_id = ? AND contact = ? ORDER BY id")
      .all(agentId, contact) as any[];
  }
  addMemory(agentId: string, contact: string, fact: string, cap = 30) {
    this.db.prepare("INSERT OR IGNORE INTO contact_memory (agent_id, contact, fact, at) VALUES (?,?,?,?)").run(agentId, contact, fact.slice(0, 300), now());
    // Keep the newest `cap` facts.
    this.db
      .prepare("DELETE FROM contact_memory WHERE agent_id = ? AND contact = ? AND id NOT IN (SELECT id FROM contact_memory WHERE agent_id = ? AND contact = ? ORDER BY id DESC LIMIT ?)")
      .run(agentId, contact, agentId, contact, cap);
  }
  forgetMemory(agentId: string, contact: string, id?: number) {
    if (id === undefined) this.db.prepare("DELETE FROM contact_memory WHERE agent_id = ? AND contact = ?").run(agentId, contact);
    else this.db.prepare("DELETE FROM contact_memory WHERE agent_id = ? AND contact = ? AND id = ?").run(agentId, contact, id);
  }

  // ---------- integration log ----------
  logIntegration(e: Omit<IntegrationLog, "id" | "at">) {
    this.db
      .prepare("INSERT INTO integration_log (agent_id, service, action, mode, request, response, at) VALUES (?,?,?,?,?,?,?)")
      .run(e.agentId, e.service, e.action, e.mode, j(e.request), j(e.response), now());
  }
  listIntegrationLog(agentId: string, limit = 100): IntegrationLog[] {
    return this.db
      .prepare("SELECT * FROM integration_log WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
      .all(agentId, limit)
      .map((r: any) => ({ ...r, agentId: r.agent_id, request: p(r.request, null), response: p(r.response, null) }));
  }
}
