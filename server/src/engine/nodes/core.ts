// Trigger, messaging and logic nodes.
import { defineNode, parseLines } from "../registry.js";
import { render, renderDeep } from "../template.js";

// ---------------- triggers ----------------
defineNode({
  type: "trigger.message",
  category: "trigger",
  label: "On message",
  description: "Starts a conversation when a contact writes on any connected channel.",
  icon: "💬",
  trigger: true,
  fields: [
    { key: "keywords", label: "Keywords (optional)", kind: "text", placeholder: "hi, start, שלום", help: "Comma separated. Empty = any message." },
    {
      key: "channels",
      label: "Channels",
      kind: "multiselect",
      options: ["webchat", "telegram", "whatsapp", "test"].map((v) => ({ value: v, label: v })),
      help: "Empty = all channels.",
    },
  ],
  ports: () => ["out"],
  run: async () => ({ port: "out" }),
});

defineNode({
  type: "trigger.webhook",
  category: "trigger",
  label: "On webhook",
  description: "Starts an automation when an external system POSTs to /hooks/:agentId/:key.",
  icon: "🪝",
  trigger: true,
  fields: [{ key: "key", label: "Hook key", kind: "text", default: "new-lead", help: "POST /hooks/<agentId>/<key>; body is available as {{message.payload}}" }],
  ports: () => ["out"],
  run: async () => ({ port: "out" }),
});

defineNode({
  type: "trigger.schedule",
  category: "trigger",
  label: "On schedule",
  description: "Runs an automation every N minutes or every day at a fixed time.",
  icon: "⏰",
  trigger: true,
  fields: [
    {
      key: "mode",
      label: "Mode",
      kind: "select",
      default: "interval",
      options: [
        { value: "interval", label: "Every N minutes" },
        { value: "daily", label: "Daily at time" },
      ],
    },
    { key: "minutes", label: "Interval (minutes)", kind: "number", default: 60, showIf: { key: "mode", in: ["interval", undefined] } },
    { key: "time", label: "Daily time (HH:MM, server time)", kind: "text", default: "09:00", showIf: { key: "mode", in: ["daily"] } },
  ],
  ports: () => ["out"],
  run: async () => ({ port: "out" }),
});

// ---------------- messaging ----------------
defineNode({
  type: "message.send",
  category: "message",
  label: "Send message",
  description: "Sends text (and optional buttons) to the contact.",
  icon: "📤",
  fields: [
    { key: "text", label: "Text", kind: "textarea", placeholder: "Hi {{contact.name}}!" },
    { key: "buttons", label: "Buttons (one per line)", kind: "lines", help: "Buttons do not wait; use Ask for a choice." },
    { key: "imageUrl", label: "Image URL", kind: "text" },
  ],
  ports: () => ["out"],
  run: async (ctx, node) => {
    const scope = ctx.scope();
    const text = String(render(node.config.text ?? "", scope));
    const buttons = parseLines(node.config.buttons).map((b) => ({ id: b.id, label: String(render(b.description, scope)) }));
    ctx.send({ text, buttons: buttons.length ? buttons : undefined, imageUrl: render(node.config.imageUrl, scope) || undefined });
    return { port: "out", output: { text } };
  },
});

const VALIDATORS: Record<string, (v: string) => boolean> = {
  text: (v) => v.trim().length > 0,
  email: (v) => /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(v.trim()),
  phone: (v) => /^\+?[\d\s-]{8,15}$/.test(v.trim()),
  number: (v) => v.trim() !== "" && !isNaN(Number(v.trim())),
  date: (v) => !isNaN(new Date(v.trim()).getTime()),
};

defineNode({
  type: "message.ask",
  category: "message",
  label: "Ask question",
  description: "Asks a question, waits for the reply, validates it and saves it to a variable.",
  icon: "❓",
  fields: [
    { key: "question", label: "Question", kind: "textarea" },
    { key: "variable", label: "Save answer to variable", kind: "text", default: "answer" },
    {
      key: "validate",
      label: "Expected answer",
      kind: "select",
      default: "text",
      options: ["text", "email", "phone", "number", "date", "choice"].map((v) => ({ value: v, label: v })),
    },
    { key: "choices", label: "Choices (one per line, id: label)", kind: "lines", help: "Each choice gets its own output port.", showIf: { key: "validate", in: ["choice"] } },
    { key: "retryText", label: "Message when the answer is invalid", kind: "text", default: "Sorry, I didn't get that. Please try again." },
    { key: "maxRetries", label: "Max retries", kind: "number", default: 2 },
  ],
  ports: (c) => (c.validate === "choice" ? [...parseLines(c.choices).map((x) => x.id), "invalid"] : ["out", "invalid"]),
  run: async (ctx, node) => {
    const scope = ctx.scope();
    const choices = parseLines(node.config.choices);
    ctx.send({
      text: String(render(node.config.question ?? "", scope)),
      buttons: node.config.validate === "choice" ? choices.map((c) => ({ id: c.id, label: String(render(c.description, scope)) })) : undefined,
    });
    ctx.session.vars.__retries = 0;
    return { wait: true };
  },
  resume: async (ctx, node, event) => {
    const cfg = node.config;
    const variable = cfg.variable || "answer";
    const raw = (event.text ?? "").trim();
    let ok = false;
    let port = "out";
    let value: any = raw;
    if (cfg.validate === "choice") {
      const choices = parseLines(cfg.choices);
      const byNumber = /^\d+$/.test(raw) ? choices[Number(raw) - 1] : undefined;
      const hit =
        choices.find((c) => c.id === event.buttonId) ??
        byNumber ??
        choices.find((c) => c.id.toLowerCase() === raw.toLowerCase() || c.description.toLowerCase() === raw.toLowerCase());
      if (hit) {
        ok = true;
        port = hit.id;
        value = hit.id;
      }
    } else {
      ok = (VALIDATORS[cfg.validate ?? "text"] ?? VALIDATORS.text)(raw);
      if (ok && cfg.validate === "number") value = Number(raw);
    }
    if (ok) {
      ctx.session.vars[variable] = value;
      delete ctx.session.vars.__retries;
      return { port, output: { [variable]: value } };
    }
    const retries = Number(ctx.session.vars.__retries ?? 0) + 1;
    ctx.session.vars.__retries = retries;
    if (retries > Number(cfg.maxRetries ?? 2)) {
      delete ctx.session.vars.__retries;
      return { port: "invalid", output: { invalid: raw } };
    }
    ctx.send({ text: String(render(cfg.retryText || "Please try again.", ctx.scope())) });
    return { wait: true, output: { invalid: raw, retries } };
  },
});

defineNode({
  type: "message.handoff",
  category: "message",
  label: "Hand off to human",
  description: "Pauses the bot for this contact and flags the conversation for a team member.",
  icon: "🙋",
  fields: [{ key: "text", label: "Message to contact", kind: "text", default: "A team member will continue with you shortly." }],
  ports: () => [],
  run: async (ctx, node) => {
    ctx.send({ text: String(render(node.config.text ?? "", ctx.scope())) });
    return { handoff: true, end: true };
  },
});

defineNode({
  type: "flow.end",
  category: "logic",
  label: "End",
  description: "Ends the conversation. Optionally clears the collected variables.",
  icon: "🏁",
  fields: [{ key: "reset", label: "Clear variables", kind: "boolean", default: false }],
  ports: () => [],
  run: async (ctx, node) => {
    if (node.config.reset) ctx.session.vars = {};
    return { end: true };
  },
});

// ---------------- logic ----------------
const OPS: Record<string, (a: any, b: any) => boolean> = {
  equals: (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase(),
  not_equals: (a, b) => String(a ?? "").toLowerCase() !== String(b ?? "").toLowerCase(),
  contains: (a, b) => String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase()),
  gt: (a, b) => Number(a) > Number(b),
  lt: (a, b) => Number(a) < Number(b),
  exists: (a) => a !== undefined && a !== null && a !== "",
  regex: (a, b) => {
    try {
      return new RegExp(String(b), "i").test(String(a ?? ""));
    } catch {
      return false;
    }
  },
};

defineNode({
  type: "logic.condition",
  category: "logic",
  label: "Condition",
  description: "Branches on a comparison.",
  icon: "🔀",
  fields: [
    { key: "left", label: "Value", kind: "text", placeholder: "{{vars.budget}}" },
    { key: "op", label: "Operator", kind: "select", default: "equals", options: Object.keys(OPS).map((v) => ({ value: v, label: v })) },
    { key: "right", label: "Compare to", kind: "text", showIf: { key: "op", in: ["equals", "not_equals", "contains", "gt", "lt", "regex", undefined] } },
  ],
  ports: () => ["true", "false"],
  run: async (ctx, node) => {
    const scope = ctx.scope();
    const a = render(node.config.left, scope);
    const b = render(node.config.right, scope);
    const result = (OPS[node.config.op] ?? OPS.equals)(a, b);
    return { port: result ? "true" : "false", output: { left: a, right: b, result } };
  },
});

defineNode({
  type: "logic.set",
  category: "logic",
  label: "Set variables",
  description: "Assigns values (templates allowed) to session variables.",
  icon: "🧮",
  fields: [{ key: "assign", label: "Assignments", kind: "keyvalue", help: "variable → value / {{template}}" }],
  ports: () => ["out"],
  run: async (ctx, node) => {
    const assign = renderDeep(node.config.assign ?? {}, ctx.scope()) as Record<string, any>;
    Object.assign(ctx.session.vars, assign);
    return { port: "out", output: assign };
  },
});

defineNode({
  type: "logic.delay",
  category: "logic",
  label: "Delay",
  description: "Waits a few seconds (typing effect / rate limiting). Max 10 s.",
  icon: "⏳",
  fields: [{ key: "seconds", label: "Seconds", kind: "number", default: 1 }],
  ports: () => ["out"],
  run: async (_ctx, node) => {
    const ms = Math.min(10, Math.max(0, Number(node.config.seconds ?? 1))) * 1000;
    if (process.env.BOTLOOM_FAST_DELAY !== "1") await new Promise((r) => setTimeout(r, ms));
    return { port: "out", output: { ms } };
  },
});
