// AI nodes: autonomous agent with tools, intent router, structured extraction, knowledge search.
import { defineNode, getNodeDef, parseLines, type RunContext } from "../registry.js";
import type { FlowNode } from "../types.js";
import { render } from "../template.js";
import { chunk, search } from "../../knowledge/bm25.js";
import type { ToolSpec } from "../../llm/provider.js";

export function kbSearch(ctx: RunContext, query: string, k = 3) {
  const chunks = ctx.services.store.listDocs(ctx.agent.id).flatMap((d) => chunk(d.id, d.title, d.content));
  return search(chunks, query, k).map((h) => ({ title: h.title, snippet: h.snippet, score: Number(h.score.toFixed(3)) }));
}

/** Tools the agent may use. Each one is a BotLoom capability, so its calls show up in the run trace. */
export const AGENT_TOOLS: Record<
  string,
  { spec: ToolSpec; label: string; run: (ctx: RunContext, node: FlowNode, input: Record<string, any>) => Promise<any> }
> = {
  knowledge_search: {
    label: "Search knowledge base",
    spec: {
      name: "knowledge_search",
      description: "Search the business knowledge base (prices, hours, policies, FAQ). Use before answering factual questions.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "What to look up" } }, required: ["query"] },
    },
    run: async (ctx, _n, input) => ({ results: kbSearch(ctx, String(input.query ?? "")) }),
  },
  save_lead: {
    label: "Save lead to Google Sheets",
    spec: {
      name: "save_lead",
      description: "Save a lead / contact request to the CRM spreadsheet once you have the person's name and a phone or email.",
      input_schema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          notes: { type: "string", description: "What they need, in one sentence" },
        },
        required: ["full_name"],
      },
    },
    run: async (ctx, node, input) => {
      const c = node.config;
      await ctx.services.google.appendRow(ctx.agent.id, c.spreadsheetId || "demo-sheet", c.sheetName || "Leads", [
        new Date().toISOString(),
        input.full_name ?? "",
        input.phone ?? "",
        input.email ?? "",
        input.notes ?? "",
        ctx.session.channel,
      ]);
      Object.assign(ctx.session.vars, { lead_name: input.full_name, lead_phone: input.phone, lead_email: input.email });
      return { ok: true, message: `Saved ${input.full_name} as a new lead.` };
    },
  },
  book_appointment: {
    label: "Book in Google Calendar",
    spec: {
      name: "book_appointment",
      description: "Book an appointment in the calendar. Ask for any missing detail first. datetime must be ISO 8601, e.g. 2026-11-03T10:30.",
      input_schema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          datetime: { type: "string", description: "ISO 8601 local date and time" },
          service: { type: "string" },
          email: { type: "string" },
        },
        required: ["full_name", "datetime"],
      },
    },
    run: async (ctx, node, input) => {
      const c = node.config;
      const ev: any = await ctx.services.google.createEvent(ctx.agent.id, c.calendarId || "primary", {
        summary: `${input.service || "Appointment"}: ${input.full_name}`,
        start: String(input.datetime),
        durationMin: Number(c.durationMin ?? 30),
        description: `Booked by BotLoom via ${ctx.session.channel}`,
        attendeeEmail: input.email || undefined,
      });
      ctx.session.vars.last_booking = { id: ev.id, start: ev.start?.dateTime ?? input.datetime };
      return { ok: true, message: `Booked ${input.full_name} for ${input.datetime}.`, eventId: ev.id };
    },
  },
  send_email: {
    label: "Send email (Gmail)",
    spec: {
      name: "send_email",
      description: "Send an email, e.g. a quote or a summary the user asked for.",
      input_schema: {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
        required: ["to", "subject", "body"],
      },
    },
    run: async (ctx, _n, input) => {
      await ctx.services.google.sendEmail(ctx.agent.id, String(input.to), String(input.subject), String(input.body));
      return { ok: true, message: `Email sent to ${input.to}.` };
    },
  },
  lookup_order: {
    label: "Look up order (HTTP API)",
    spec: {
      name: "lookup_order",
      description: "Look up an order's status in the store's system by order number.",
      input_schema: { type: "object", properties: { order_number: { type: "string" } }, required: ["order_number"] },
    },
    run: async (ctx, node, input) => {
      const url = String(node.config.lookupUrl || "");
      if (!url) return { ok: true, sandbox: true, order: input.order_number, status: "shipped", eta: "2 business days" };
      const res = await ctx.services.http(url.replace("{order}", encodeURIComponent(String(input.order_number))));
      return await res.json();
    },
  },
  handoff_to_human: {
    label: "Hand off to a human",
    spec: {
      name: "handoff_to_human",
      description: "Transfer the conversation to a human team member when the user asks for one, is upset, or you cannot help.",
      input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
    run: async (ctx, _n, input) => {
      ctx.session.handoff = true;
      ctx.session.vars.handoff_reason = input.reason;
      return { ok: true, message: "Conversation flagged for a human." };
    },
  },
};

defineNode({
  type: "ai.agent",
  category: "ai",
  label: "AI agent",
  description: "Claude answers the contact, using the tools you allow (knowledge base, Sheets, Calendar, Gmail, APIs, handoff).",
  icon: "🤖",
  fields: [
    { key: "instructions", label: "Instructions", kind: "textarea", placeholder: "You are the receptionist of ..." },
    {
      key: "tools",
      label: "Tools",
      kind: "multiselect",
      options: Object.entries(AGENT_TOOLS).map(([value, t]) => ({ value, label: t.label })),
      default: ["knowledge_search"],
    },
    {
      key: "flowTools",
      label: "Flow nodes as tools (node ids, one per line)",
      kind: "lines",
      help: "Any integration node becomes a tool. Write {{ai.field}} in its config (optionally {{ai.field | desc: 'what it is'}}) and Claude fills those values when it calls the tool.",
    },
    { key: "model", label: "Model (empty = agent default)", kind: "text", placeholder: "claude-opus-5-5" },
    { key: "input", label: "User input", kind: "text", default: "{{message.text}}" },
    { key: "saveAs", label: "Save reply to variable", kind: "text", default: "ai_reply" },
    { key: "sendReply", label: "Send reply to contact", kind: "boolean", default: true },
    { key: "loop", label: "Stay in conversation (wait for next message)", kind: "boolean", default: true },
    { key: "spreadsheetId", showIf: { key: "tools", in: ["save_lead"] }, label: "Sheets: spreadsheet id", kind: "text" },
    { key: "sheetName", showIf: { key: "tools", in: ["save_lead"] }, label: "Sheets: tab name", kind: "text", default: "Leads" },
    { key: "calendarId", label: "Calendar id", kind: "text", default: "primary", showIf: { key: "tools", in: ["book_appointment"] } },
    { key: "durationMin", label: "Appointment length (min)", kind: "number", default: 30, showIf: { key: "tools", in: ["book_appointment"] } },
    { key: "lookupUrl", label: "Order API URL ({order} placeholder)", kind: "text", showIf: { key: "tools", in: ["lookup_order"] } },
  ],
  ports: () => ["out", "handoff"],
  run: (ctx, node) => runAgent(ctx, node, String(render(node.config.input ?? "{{message.text}}", ctx.scope()) ?? "")),
  resume: (ctx, node, event) => runAgent(ctx, node, event.text ?? ""),
});

/**
 * AI-filled parameters: collect {{ai.x}} placeholders
 * in a node's config and turn them into a tool input schema.
 */
export function aiPlaceholders(config: unknown): { name: string; description: string }[] {
  const found = new Map<string, string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\{\{\s*ai\.([A-Za-z_]\w*)\s*(?:\|\s*desc\s*:\s*["']([^"']*)["'])?[^}]*\}\}/g)) {
        if (!found.has(m[1]) || m[2]) found.set(m[1], m[2] ?? m[1].replace(/_/g, " "));
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(config);
  return [...found].map(([name, description]) => ({ name, description }));
}

export function flowToolSpecs(ctx: RunContext, ids: string[]) {
  const specs: { spec: ToolSpec; node: FlowNode }[] = [];
  for (const id of ids) {
    const target = ctx.agent.flow.nodes.find((n) => n.id === id);
    const def = target && getNodeDef(target.type);
    if (!target || !def || def.trigger || target.type.startsWith("ai.") || target.type.startsWith("message.")) continue;
    const params = aiPlaceholders(target.config);
    specs.push({
      node: target,
      spec: {
        name: `flow_${id.replace(/[^\w-]/g, "_")}`.slice(0, 64),
        description: `${target.label || def.label}: ${def.description}`,
        input_schema: {
          type: "object",
          properties: Object.fromEntries(params.map((p) => [p.name, { type: "string", description: p.description }])),
          required: params.map((p) => p.name),
        },
      },
    });
  }
  return specs;
}

async function runAgent(ctx: RunContext, node: FlowNode, userText: string) {
  const cfg = node.config;
  const allowed: string[] = (cfg.tools ?? []).filter((t: string) => AGENT_TOOLS[t]);
  const globalAllow = ctx.agent.settings.allowedTools;
  const tools = allowed.filter((t) => !globalAllow || globalAllow.includes(t));
  const scope = ctx.scope();
  const knownVars = Object.fromEntries(Object.entries(ctx.session.vars).filter(([k]) => !k.startsWith("__")));
  const system = [
    ctx.agent.settings.systemPrompt ? String(render(ctx.agent.settings.systemPrompt, scope)) : "",
    cfg.instructions ? String(render(cfg.instructions, scope)) : "You are a helpful assistant for a small business.",
    `You are chatting on ${ctx.session.channel}. Keep replies short and friendly, suitable for a chat app. Reply in the user's language (Hebrew or English).`,
    `Today is ${new Date().toISOString().slice(0, 10)}. Contact name: ${ctx.session.contactName ?? "unknown"}.`,
    Object.keys(knownVars).length ? `Known details about this contact: ${JSON.stringify(knownVars)}` : "",
    tools.includes("knowledge_search") ? "Use knowledge_search for any business fact; if it has no answer, say you will check with the team." : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // History excludes the current message (it is the userText).
  const history = ctx.session.history.slice(-12, -1).map((h) => ({ role: h.role, text: h.text }));
  while (history.length && history[0].role !== "user") history.shift();

  const flowTools = flowToolSpecs(ctx, parseLines(cfg.flowTools).map((l) => l.id));

  const result = await ctx.services.llm.runAgent({
    model: cfg.model || ctx.agent.settings.model,
    system,
    history,
    userText,
    tools: [...tools.map((t) => AGENT_TOOLS[t].spec), ...flowTools.map((f) => f.spec)],
    executeTool: async (name, input) => {
      const ft = flowTools.find((f) => f.spec.name === name);
      if (ft) {
        // Run the flow node with the AI-filled values exposed as {{ai.*}}.
        const sub: RunContext = { ...ctx, scope: () => ({ ...ctx.scope(), ai: input }) };
        const res = await getNodeDef(ft.node.type)!.run(sub, ft.node);
        return JSON.stringify({ port: res.port, output: res.output });
      }
      const tool = AGENT_TOOLS[name];
      if (!tool || !tools.includes(name)) throw new Error(`Tool ${name} is not allowed for this agent`);
      return JSON.stringify(await tool.run(ctx, node, input));
    },
  });

  ctx.session.vars[cfg.saveAs || "ai_reply"] = result.text;
  if (cfg.sendReply !== false && result.text) ctx.send({ text: result.text });
  const output = { text: result.text, toolCalls: result.toolCalls, provider: result.provider, usage: result.usage };
  if (ctx.session.handoff) return { port: "handoff", output };
  if (cfg.loop !== false) return { wait: true, output };
  return { port: "out", output };
}

defineNode({
  type: "ai.intent",
  category: "ai",
  label: "Intent router",
  description: "Classifies the message into one of your intents; each intent is an output port.",
  icon: "🧭",
  fields: [
    { key: "input", label: "Text to classify", kind: "text", default: "{{message.text}}" },
    { key: "intents", label: "Intents (id: description)", kind: "lines", placeholder: "booking: wants to book or change an appointment" },
  ],
  ports: (c) => [...parseLines(c.intents).map((i) => i.id), "fallback"],
  run: async (ctx, node) => {
    const text = String(render(node.config.input ?? "{{message.text}}", ctx.scope()) ?? "");
    const intents = parseLines(node.config.intents);
    const intent = text ? await ctx.services.llm.classify(text, intents, ctx.agent.settings.model) : null;
    ctx.session.vars.intent = intent ?? "fallback";
    return { port: intent && intents.some((i) => i.id === intent) ? intent : "fallback", output: { intent } };
  },
});

defineNode({
  type: "ai.extract",
  category: "ai",
  label: "Extract data",
  description: "Pulls structured fields (name, phone, date...) out of free text into variables.",
  icon: "🧲",
  fields: [
    { key: "input", label: "Text", kind: "text", default: "{{message.text}}" },
    { key: "fields", label: "Fields (name: description)", kind: "lines", placeholder: "full_name: the person's name" },
  ],
  ports: () => ["complete", "partial"],
  run: async (ctx, node) => {
    const text = String(render(node.config.input ?? "{{message.text}}", ctx.scope()) ?? "");
    const fields = parseLines(node.config.fields).map((f) => ({ name: f.id, description: f.description }));
    const values = await ctx.services.llm.extract(text, fields, ctx.agent.settings.model);
    for (const [k, v] of Object.entries(values)) if (v !== null && v !== "") ctx.session.vars[k] = v;
    const complete = fields.every((f) => ctx.session.vars[f.name]);
    return { port: complete ? "complete" : "partial", output: values };
  },
});

defineNode({
  type: "kb.search",
  category: "ai",
  label: "Knowledge search",
  description: "Searches the agent's documents and stores the best matches in a variable.",
  icon: "📚",
  fields: [
    { key: "query", label: "Query", kind: "text", default: "{{message.text}}" },
    { key: "saveAs", label: "Save to variable", kind: "text", default: "kb" },
    { key: "k", label: "Results", kind: "number", default: 3 },
  ],
  ports: () => ["found", "empty"],
  run: async (ctx, node) => {
    const hits = kbSearch(ctx, String(render(node.config.query, ctx.scope()) ?? ""), Number(node.config.k ?? 3));
    ctx.session.vars[node.config.saveAs || "kb"] = hits;
    return { port: hits.length ? "found" : "empty", output: hits };
  },
});
