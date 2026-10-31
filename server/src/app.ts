// HTTP API: builder/admin API, channel webhooks, web-chat widget endpoint, automation hooks.
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store, newId } from "./db.js";
import { Engine } from "./engine/executor.js";
import { listNodeDefs, getNodeDef, type Services } from "./engine/registry.js";
import type { Agent, ChannelKind, Flow, InboundEvent } from "./engine/types.js";
import { ChannelHub, parseTelegram, parseWhatsApp } from "./channels/hub.js";
import { GoogleClient } from "./integrations/google.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { MockProvider } from "./llm/mock.js";
import type { LlmProvider } from "./llm/provider.js";
import { TEMPLATES } from "./templates.js";
import { designAgent, reviseAgent } from "./ai/designer.js";
import { AGENT_TOOLS } from "./engine/nodes/ai.js";
import { chunk, search } from "./knowledge/bm25.js";

export interface AppOptions {
  store?: Store;
  llm?: LlmProvider;
  http?: typeof fetch;
  adminToken?: string;
  webDist?: string;
}

const FlowSchema = z.object({
  nodes: z.array(z.object({ id: z.string().min(1), type: z.string(), label: z.string().optional(), position: z.object({ x: z.number(), y: z.number() }).optional(), config: z.record(z.string(), z.any()).default({}) })),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), sourcePort: z.string().optional() })),
});
const AgentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  flow: FlowSchema,
  settings: z
    .object({ model: z.string().optional(), systemPrompt: z.string().optional(), language: z.enum(["he", "en"]).optional(), allowedTools: z.array(z.string()).optional() })
    .default({}),
});

/** Structural checks the builder shows as warnings; unknown types and dangling edges are rejected. */
export function validateFlow(flow: Flow): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const n of flow.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!getNodeDef(n.type)) errors.push(`Unknown node type ${n.type}`);
  }
  for (const e of flow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) errors.push(`Edge ${e.id} points to a missing node`);
    const src = flow.nodes.find((n) => n.id === e.source);
    const def = src && getNodeDef(src.type);
    if (def && !def.ports(src!.config).includes(e.sourcePort ?? "out")) warnings.push(`Edge ${e.id} uses unknown port "${e.sourcePort}" on ${e.source}`);
  }
  if (!flow.nodes.some((n) => getNodeDef(n.type)?.trigger)) warnings.push("Flow has no trigger node");

  // Graph analysis: adjacency list + reachability from triggers.
  const adj = new Map<string, string[]>();
  for (const e of flow.edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  const toolNodes = new Set(
    flow.nodes.filter((n) => n.type === "ai.agent").flatMap((n) => String(n.config.flowTools ?? "").split("\n").map((x) => x.trim()).filter(Boolean)),
  );
  const reachable = new Set<string>();
  const stack = flow.nodes.filter((n) => getNodeDef(n.type)?.trigger).map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(adj.get(id) ?? []));
  }
  for (const n of flow.nodes) {
    if (reachable.has(n.id)) continue;
    if (toolNodes.has(n.id)) continue; // used by an AI agent as a tool
    warnings.push(`Node ${n.id} is not reachable from any trigger`);
  }
  // A cycle with no waiting node would spin until the step limit.
  const waits = new Set(flow.nodes.filter((n) => n.type === "message.ask" || n.type === "ai.agent").map((n) => n.id));
  const state = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1);
    const here = [...path, id];
    for (const next of adj.get(id) ?? []) {
      if (state.get(next) === 1) {
        const cycle = here.slice(here.indexOf(next));
        if (!cycle.some((c) => waits.has(c))) warnings.push(`Loop without a waiting step: ${cycle.join(" → ")} → ${next}`);
      } else if (!state.get(next)) visit(next, here);
    }
    state.set(id, 2);
  };
  for (const n of flow.nodes) if (!state.get(n.id)) visit(n.id, []);
  return { errors, warnings };
}

/** Claude conversations must start with a user turn. */
const trimToUserFirst = <T extends { role: string }>(h: T[]) => {
  const out = [...h];
  while (out.length && out[0].role !== "user") out.shift();
  return out;
};

const mask = (v: unknown) => (typeof v === "string" && v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v ? "••••" : "");

export async function buildApp(opts: AppOptions = {}) {
  const store = opts.store ?? new Store();
  const http = opts.http ?? fetch;
  const llm = opts.llm ?? (process.env.ANTHROPIC_API_KEY ? new AnthropicProvider() : new MockProvider());
  const google = new GoogleClient(store, process.env, http);
  const hub = new ChannelHub(store, http);
  const services: Services = { store, llm, google, http, notify: (agentId, ch, to, msg) => hub.send(agentId, ch, to, msg) };
  const engine = new Engine(services);
  const adminToken = opts.adminToken ?? process.env.BOTLOOM_ADMIN_TOKEN;

  const app: FastifyInstance = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: "info" }, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // Raw body for WhatsApp signature verification.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!adminToken || !req.url.startsWith("/api/") || req.url === "/api/health") return;
    if (req.headers.authorization !== `Bearer ${adminToken}`) reply.code(401).send({ error: "Unauthorized" });
  });

  const agentOr404 = (id: string, reply: any): Agent | undefined => {
    const a = store.getAgent(id);
    if (!a) reply.code(404).send({ error: "Agent not found" });
    return a;
  };

  async function dispatch(agent: Agent, event: InboundEvent, deliver: boolean, opts2 = {}) {
    const outcome = await engine.handle(agent, event, opts2);
    let deliveries: any[] = [];
    if (deliver) deliveries = await hub.deliver(agent.id, event.channel, event.contactId, outcome.outbox);
    return { ...outcome, deliveries };
  }

  // ---------------- meta ----------------
  app.get("/api/health", async () => ({ ok: true, llm: llm.name, google: google.live ? "live" : "sandbox" }));
  app.get("/api/node-types", async () =>
    listNodeDefs().map((d) => ({ type: d.type, category: d.category, label: d.label, description: d.description, icon: d.icon, trigger: !!d.trigger, fields: d.fields, ports: d.ports({}) })),
  );
  app.post("/api/node-types/:type/ports", async (req: any, reply) => {
    const def = getNodeDef(req.params.type);
    if (!def) return reply.code(404).send({ error: "Unknown node type" });
    return { ports: def.ports(req.body ?? {}) };
  });
  app.get("/api/templates", async () => TEMPLATES.map(({ flow, docs, ...t }) => ({ ...t, nodes: flow.nodes.length })));

  // ---------------- agents ----------------
  app.get("/api/agents", async () => store.listAgents().map((a) => ({ ...a, stats: store.stats(a.id) })));
  app.post("/api/agents", async (req, reply) => {
    const parsed = AgentSchema.safeParse(req.body ?? { name: "New agent", flow: { nodes: [], edges: [] } });
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const v = validateFlow(parsed.data.flow as Flow);
    if (v.errors.length) return reply.code(400).send({ error: v.errors });
    return store.saveAgent({ id: newId("agt"), ...parsed.data, flow: parsed.data.flow as Flow });
  });
  app.post("/api/agents/from-template/:tid", async (req: any, reply) => {
    const t = TEMPLATES.find((x) => x.id === req.params.tid);
    if (!t) return reply.code(404).send({ error: "Template not found" });
    const agent = store.saveAgent({ id: newId("agt"), name: t.name, description: t.description, flow: structuredClone(t.flow), settings: { language: t.language, systemPrompt: t.systemPrompt } });
    for (const d of t.docs ?? []) store.addDoc(agent.id, d.title, d.content);
    return agent;
  });
  // AI-native creation: describe the bot in plain language, Claude designs the whole agent.
  app.post("/api/agents/design", async (req: any, reply) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (prompt.length < 10) return reply.code(400).send({ error: "Describe the bot in at least a sentence" });
    try {
      const d = await designAgent(llm, prompt.slice(0, 4000), validateFlow);
      const agent = store.saveAgent({ id: newId("agt"), name: d.name, description: d.description, flow: d.flow, settings: { language: d.language, systemPrompt: d.systemPrompt } });
      for (const doc of d.docs) store.addDoc(agent.id, doc.title, doc.content);
      return { agent, notes: d.notes, designer: d.designer };
    } catch (err: any) {
      return reply.code(502).send({ error: String(err.message ?? err) });
    }
  });
  // Flow copilot: Claude edits the existing agent from a plain-language instruction. Returns a
  // validated proposal; nothing is saved until the user applies it in the builder.
  app.post("/api/agents/:id/revise", async (req: any, reply) => {
    const a = agentOr404(req.params.id, reply);
    if (!a) return;
    const instruction = String(req.body?.instruction ?? "").trim();
    if (instruction.length < 4) return reply.code(400).send({ error: "Write what to change" });
    try {
      const d = await reviseAgent(llm, a, instruction.slice(0, 4000), validateFlow);
      return { flow: d.flow, systemPrompt: d.systemPrompt, notes: d.notes, docs: d.docs, validation: validateFlow(d.flow) };
    } catch (err: any) {
      return reply.code(llm.name === "mock" ? 400 : 502).send({ error: String(err.message ?? err) });
    }
  });
  app.get("/api/agents/:id", async (req: any, reply) => {
    const a = agentOr404(req.params.id, reply);
    return a && { ...a, validation: validateFlow(a.flow), stats: store.stats(a.id) };
  });
  app.put("/api/agents/:id", async (req: any, reply) => {
    const a = agentOr404(req.params.id, reply);
    if (!a) return;
    const parsed = AgentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const v = validateFlow(parsed.data.flow as Flow);
    if (v.errors.length) return reply.code(400).send({ error: v.errors });
    return { ...store.saveAgent({ id: a.id, ...parsed.data, flow: parsed.data.flow as Flow }), validation: v };
  });
  app.delete("/api/agents/:id", async (req: any) => {
    store.deleteAgent(req.params.id);
    return { ok: true };
  });

  // Simulator: talk to the agent from the builder.
  app.post("/api/agents/:id/chat", async (req: any, reply) => {
    const a = agentOr404(req.params.id, reply);
    if (!a) return;
    const b = req.body ?? {};
    const outcome = await dispatch(a, { channel: "test", contactId: String(b.contactId ?? "tester"), contactName: b.contactName ?? "Tester", text: String(b.text ?? ""), buttonId: b.buttonId }, false);
    return { messages: outcome.outbox, run: outcome.run, session: outcome.session };
  });
  // Manually fire a webhook/schedule trigger from the builder.
  app.post("/api/agents/:id/trigger/:nodeId", async (req: any, reply) => {
    const a = agentOr404(req.params.id, reply);
    if (!a) return;
    const node = a.flow.nodes.find((n) => n.id === req.params.nodeId);
    if (!node || !getNodeDef(node.type)?.trigger) return reply.code(404).send({ error: "Trigger not found" });
    const outcome = await dispatch(a, { channel: "webhook", contactId: `manual:${node.id}`, payload: req.body ?? {} }, false, { triggerNodeId: node.id, triggerLabel: `manual:${node.type}` });
    return { messages: outcome.outbox, run: outcome.run };
  });

  app.get("/api/agents/:id/runs", async (req: any) => store.listRuns(req.params.id, Number(req.query.limit ?? 50)));
  app.get("/api/agents/:id/sessions", async (req: any) => store.listSessions(req.params.id));
  app.get("/api/agents/:id/integrations-log", async (req: any) => store.listIntegrationLog(req.params.id));
  app.delete("/api/sessions/:sid", async (req: any) => {
    store.deleteSession(req.params.sid);
    return { ok: true };
  });
  // Human inbox: reply as a team member, or give the conversation back to the bot.
  app.post("/api/sessions/:sid/reply", async (req: any, reply) => {
    const s = store.getSession(req.params.sid);
    if (!s) return reply.code(404).send({ error: "Session not found" });
    const text = String(req.body?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "text required" });
    s.history.push({ role: "assistant", text: `[team] ${text}`, at: new Date().toISOString() });
    store.saveSession(s);
    const delivery = await hub.send(s.agentId, s.channel, s.contactId, { text });
    return { ok: true, delivery };
  });
  app.post("/api/sessions/:sid/release", async (req: any, reply) => {
    const s = store.getSession(req.params.sid);
    if (!s) return reply.code(404).send({ error: "Session not found" });
    s.handoff = false;
    s.wait = null;
    delete s.vars.__brief;
    store.saveSession(s);
    return { ok: true };
  });
  // AI copilot for the team member: Claude drafts the next reply from the transcript and knowledge base.
  app.post("/api/sessions/:sid/suggest", async (req: any, reply) => {
    const s = store.getSession(req.params.sid);
    const agent = s && store.getAgent(s.agentId);
    if (!s || !agent) return reply.code(404).send({ error: "Session not found" });
    const lastUser = [...s.history].reverse().find((h) => h.role === "user");
    if (!lastUser) return reply.code(400).send({ error: "No customer message to answer" });
    const chunks = store.listDocs(agent.id).flatMap((d) => chunk(d.id, d.title, d.content));
    const result = await llm.runAgent({
      model: agent.settings.model,
      system: [
        agent.settings.systemPrompt ?? "",
        "You draft the next reply for a human support agent who took over this chat. Write only the message text, short, in the customer's language. Check facts with knowledge_search; if it has no answer, draft a polite holding reply.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      history: trimToUserFirst(s.history.slice(-12, -1).map((h) => ({ role: h.role, text: h.text.replace(/^\[team\] /, "") }))),
      userText: lastUser.text,
      tools: [AGENT_TOOLS.knowledge_search.spec],
      executeTool: async (_name, input) => JSON.stringify({ results: search(chunks, String(input.query ?? ""), 3) }),
    });
    return { draft: result.text, provider: result.provider };
  });
  app.get("/api/sessions/:sid/memory", async (req: any, reply) => {
    const s = store.getSession(req.params.sid);
    if (!s) return reply.code(404).send({ error: "Session not found" });
    return store.listMemory(s.agentId, `${s.channel}:${s.contactId}`);
  });
  app.delete("/api/sessions/:sid/memory/:mid", async (req: any, reply) => {
    const s = store.getSession(req.params.sid);
    if (!s) return reply.code(404).send({ error: "Session not found" });
    store.forgetMemory(s.agentId, `${s.channel}:${s.contactId}`, Number(req.params.mid));
    return { ok: true };
  });

  // ---------------- knowledge ----------------
  app.get("/api/agents/:id/docs", async (req: any) => store.listDocs(req.params.id));
  app.post("/api/agents/:id/docs", async (req: any, reply) => {
    const title = String(req.body?.title ?? "").trim();
    const content = String(req.body?.content ?? "").trim();
    if (!title || !content) return reply.code(400).send({ error: "title and content required" });
    return store.addDoc(req.params.id, title, content.slice(0, 200_000));
  });
  app.delete("/api/docs/:docId", async (req: any) => {
    store.deleteDoc(req.params.docId);
    return { ok: true };
  });

  // ---------------- channels ----------------
  app.get("/api/agents/:id/channels", async (req: any) =>
    store.listChannels(req.params.id).map((c) => ({
      ...c,
      config: Object.fromEntries(Object.entries(c.config).map(([k, v]) => [k, /token|secret|webhookurl/i.test(k) ? mask(v) : v])),
    })),
  );
  app.put("/api/agents/:id/channels/:kind", async (req: any, reply) => {
    const kind = req.params.kind as ChannelKind;
    if (!["telegram", "whatsapp", "webchat", "slack", "discord"].includes(kind)) return reply.code(400).send({ error: "Unsupported channel" });
    const cfg = Object.fromEntries(Object.entries(req.body?.config ?? {}).filter(([, v]) => typeof v === "string" && v && !String(v).includes("…") && v !== "••••"));
    if (kind === "telegram" && !store.listChannels(req.params.id).find((c) => c.kind === "telegram")) cfg.webhookSecret = randomBytes(16).toString("hex");
    if (kind === "whatsapp" && !cfg.verifyToken && !store.listChannels(req.params.id).find((c) => c.kind === "whatsapp")) cfg.verifyToken = randomBytes(12).toString("hex");
    const ch = store.upsertChannel(req.params.id, kind, cfg, req.body?.enabled !== false);
    return { id: ch.id, kind: ch.kind, enabled: ch.enabled };
  });
  app.post("/api/agents/:id/channels/telegram/register", async (req: any, reply) => {
    const ch = hub.channel(req.params.id, "telegram");
    if (!ch?.config.botToken) return reply.code(400).send({ error: "Save a Telegram bot token first" });
    const publicUrl = String(req.body?.publicUrl ?? "").replace(/\/$/, "");
    if (!/^https:\/\//.test(publicUrl)) return reply.code(400).send({ error: "publicUrl must be https" });
    return hub.registerTelegramWebhook(ch.config.botToken, `${publicUrl}/webhooks/telegram/${req.params.id}`, ch.config.webhookSecret);
  });

  // ---------------- public: channel webhooks ----------------
  app.post("/webhooks/telegram/:agentId", async (req: any, reply) => {
    const agent = store.getAgent(req.params.agentId);
    const ch = agent && hub.channel(agent.id, "telegram");
    if (!agent || !ch) return reply.code(404).send();
    if (ch.config.webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== ch.config.webhookSecret) return reply.code(401).send();
    const event = parseTelegram(req.body);
    if (event?.payload?.callbackQueryId) {
      // Stop the button's loading spinner in the Telegram client.
      await http(`https://api.telegram.org/bot${ch.config.botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: event.payload.callbackQueryId }),
      }).catch(() => {});
    }
    if (event) await dispatch(agent, event, true);
    return { ok: true };
  });

  app.get("/webhooks/whatsapp/:agentId", async (req: any, reply) => {
    const ch = hub.channel(req.params.agentId, "whatsapp");
    const q = req.query;
    if (ch && q["hub.mode"] === "subscribe" && q["hub.verify_token"] === ch.config.verifyToken) return reply.type("text/plain").send(q["hub.challenge"]);
    return reply.code(403).send();
  });
  app.post("/webhooks/whatsapp/:agentId", async (req: any, reply) => {
    const agent = store.getAgent(req.params.agentId);
    const ch = agent && hub.channel(agent.id, "whatsapp");
    if (!agent || !ch) return reply.code(404).send();
    if (ch.config.appSecret) {
      const expected = "sha256=" + createHmac("sha256", ch.config.appSecret).update(req.rawBody ?? "").digest("hex");
      const got = String(req.headers["x-hub-signature-256"] ?? "");
      if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return reply.code(401).send();
    }
    for (const event of parseWhatsApp(req.body)) await dispatch(agent, event, true);
    return { ok: true };
  });

  // Automations: external systems (store, CRM, forms, Make/Zapier) start a flow.
  app.post("/hooks/:agentId/:key", async (req: any, reply) => {
    const agent = store.getAgent(req.params.agentId);
    const node = agent?.flow.nodes.find((n) => n.type === "trigger.webhook" && n.config.key === req.params.key);
    if (!agent || !node) return reply.code(404).send({ error: "Hook not found" });
    const outcome = await dispatch(agent, { channel: "webhook", contactId: `hook:${req.params.key}`, payload: req.body ?? {} }, false, { triggerNodeId: node.id, triggerLabel: `webhook:${req.params.key}` });
    return { runId: outcome.run.id, status: outcome.run.status, messages: outcome.outbox };
  });

  // Web chat widget (public; visitor id is generated by the widget and kept in localStorage).
  app.post("/widget/:agentId/message", async (req: any, reply) => {
    const agent = store.getAgent(req.params.agentId);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    const b = req.body ?? {};
    const visitor = String(b.visitorId ?? "").slice(0, 64);
    if (!/^[\w-]{6,64}$/.test(visitor)) return reply.code(400).send({ error: "invalid visitorId" });
    const outcome = await dispatch(agent, { channel: "webchat", contactId: visitor, contactName: b.name, text: String(b.text ?? "").slice(0, 4000), buttonId: b.buttonId }, false);
    return { messages: outcome.outbox, waiting: outcome.session.wait !== null, handoff: outcome.session.handoff };
  });
  // Returning visitors get their conversation back.
  app.get("/widget/:agentId/history", async (req: any, reply) => {
    const visitor = String(req.query.visitorId ?? "");
    if (!/^[\w-]{6,64}$/.test(visitor)) return reply.code(400).send({ error: "invalid visitorId" });
    const s = store.listSessions(req.params.agentId).find((x) => x.channel === "webchat" && x.contactId === visitor);
    return { history: (s?.history ?? []).map((h) => ({ role: h.role, text: h.text.replace(/^\[team\] /, "") })), waiting: !!s?.wait };
  });
  app.get("/widget/:agentId/info", async (req: any, reply) => {
    const agent = store.getAgent(req.params.agentId);
    if (!agent) return reply.code(404).send();
    return { name: agent.name, language: agent.settings.language ?? "en" };
  });

  const widgetFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../public/widget.js");
  app.get("/widget.js", async (_req, reply) => reply.type("application/javascript").send(fs.readFileSync(widgetFile, "utf8")));

  const dist = opts.webDist ?? path.resolve(process.cwd(), "../web/dist");
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      reply.code(404).send({ error: "Not found" });
    });
  }

  return { app, store, engine, hub, services };
}
