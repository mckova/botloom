// Integration nodes: HTTP, Google Sheets / Calendar / Gmail, cross-channel notifications.
import { defineNode, parseLines } from "../registry.js";
import { render, renderDeep } from "../template.js";

const PRIVATE_HOST = /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.internal$)/i;

export function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are allowed");
  if (process.env.BOTLOOM_ALLOW_PRIVATE_HTTP !== "1" && PRIVATE_HOST.test(url.hostname)) {
    throw new Error(`Blocked request to private address ${url.hostname} (set BOTLOOM_ALLOW_PRIVATE_HTTP=1 to allow)`);
  }
  return url;
}

defineNode({
  type: "http.request",
  category: "integration",
  label: "HTTP request",
  description: "Calls any REST API / webhook (Make, Zapier, your backend). Private network addresses are blocked by default.",
  icon: "🌐",
  fields: [
    { key: "method", label: "Method", kind: "select", default: "POST", options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((v) => ({ value: v, label: v })) },
    { key: "url", label: "URL", kind: "text", placeholder: "https://api.example.com/leads" },
    { key: "headers", label: "Headers", kind: "keyvalue" },
    { key: "body", label: "JSON body (templates allowed)", kind: "textarea", placeholder: '{"name": "{{vars.full_name}}"}' },
    { key: "saveAs", label: "Save response to variable", kind: "text", default: "http" },
  ],
  ports: () => ["success", "error"],
  run: async (ctx, node) => {
    const scope = ctx.scope();
    const c = node.config;
    try {
      const url = assertPublicUrl(String(render(c.url, scope)));
      const headers = { "Content-Type": "application/json", ...(renderDeep(c.headers ?? {}, scope) as Record<string, string>) };
      let body: string | undefined;
      if (c.body && c.method !== "GET") {
        // Render inside the parsed JSON so user values cannot break out of string literals.
        try {
          body = JSON.stringify(renderDeep(JSON.parse(c.body), scope));
        } catch {
          body = String(render(c.body, scope));
        }
      }
      const res = await ctx.services.http(url, { method: c.method || "POST", headers, body, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {}
      ctx.session.vars[c.saveAs || "http"] = data;
      return { port: res.ok ? "success" : "error", output: { status: res.status, data } };
    } catch (err: any) {
      ctx.session.vars[c.saveAs || "http"] = { error: String(err.message ?? err) };
      return { port: "error", output: { error: String(err.message ?? err) } };
    }
  },
});

defineNode({
  type: "google.sheets.append",
  category: "integration",
  label: "Google Sheets: add row",
  description: "Appends a row to a spreadsheet (lead lists, orders, registrations).",
  icon: "📊",
  fields: [
    { key: "spreadsheetId", label: "Spreadsheet id", kind: "text" },
    { key: "sheet", label: "Tab", kind: "text", default: "Sheet1" },
    { key: "columns", label: "Columns (one value per line)", kind: "lines", placeholder: "{{vars.full_name}}\n{{vars.phone}}" },
  ],
  ports: () => ["out", "error"],
  run: async (ctx, node) => {
    const scope = ctx.scope();
    const values = (Array.isArray(node.config.columns) ? node.config.columns : String(node.config.columns ?? "").split("\n"))
      .filter((v: string) => v !== "")
      .map((v: string) => render(v, scope));
    try {
      const out = await ctx.services.google.appendRow(ctx.agent.id, node.config.spreadsheetId || "demo-sheet", node.config.sheet || "Sheet1", values);
      return { port: "out", output: { values, result: out } };
    } catch (err: any) {
      return { port: "error", output: { error: err.message } };
    }
  },
});

defineNode({
  type: "google.calendar.create",
  category: "integration",
  label: "Google Calendar: create event",
  description: "Creates a calendar event (appointments, meetings, reminders).",
  icon: "📅",
  fields: [
    { key: "calendarId", label: "Calendar id", kind: "text", default: "primary" },
    { key: "summary", label: "Title", kind: "text", default: "Meeting with {{vars.full_name}}" },
    { key: "start", label: "Start (ISO date-time)", kind: "text", default: "{{vars.datetime}}" },
    { key: "durationMin", label: "Duration (minutes)", kind: "number", default: 30 },
    { key: "attendee", label: "Attendee email", kind: "text", default: "{{vars.email}}" },
  ],
  ports: () => ["out", "error"],
  run: async (ctx, node) => {
    const s = ctx.scope();
    const c = node.config;
    try {
      const ev: any = await ctx.services.google.createEvent(ctx.agent.id, c.calendarId || "primary", {
        summary: String(render(c.summary, s)),
        start: String(render(c.start, s)),
        durationMin: Number(c.durationMin ?? 30),
        attendeeEmail: String(render(c.attendee ?? "", s)) || undefined,
      });
      ctx.session.vars.event = { id: ev.id, link: ev.htmlLink, start: ev.start?.dateTime };
      return { port: "out", output: ev };
    } catch (err: any) {
      return { port: "error", output: { error: err.message } };
    }
  },
});

defineNode({
  type: "gmail.send",
  category: "integration",
  label: "Gmail: send email",
  description: "Sends an email (confirmations, quotes, internal alerts).",
  icon: "✉️",
  fields: [
    { key: "to", label: "To", kind: "text", default: "{{vars.email}}" },
    { key: "subject", label: "Subject", kind: "text" },
    { key: "body", label: "Body", kind: "textarea" },
  ],
  ports: () => ["out", "error"],
  run: async (ctx, node) => {
    const s = ctx.scope();
    try {
      const out = await ctx.services.google.sendEmail(ctx.agent.id, String(render(node.config.to, s)), String(render(node.config.subject, s)), String(render(node.config.body, s)));
      return { port: "out", output: out };
    } catch (err: any) {
      return { port: "error", output: { error: err.message } };
    }
  },
});

defineNode({
  type: "channel.notify",
  category: "integration",
  label: "Notify on channel",
  description: "Sends a message to a specific Telegram chat or WhatsApp number, e.g. alert the business owner about a new lead.",
  icon: "📣",
  fields: [
    { key: "channel", label: "Channel", kind: "select", default: "telegram", options: ["telegram", "whatsapp"].map((v) => ({ value: v, label: v })) },
    { key: "to", label: "Chat id / phone number", kind: "text" },
    { key: "text", label: "Text", kind: "textarea", default: "New lead: {{vars.full_name}} ({{vars.phone}})" },
    { key: "buttons", label: "Buttons (one per line)", kind: "lines" },
  ],
  ports: () => ["out"],
  run: async (ctx, node) => {
    const s = ctx.scope();
    const to = String(render(node.config.to, s));
    const buttons = parseLines(node.config.buttons).map((b) => ({ id: b.id, label: b.description }));
    const res = await ctx.services.notify(ctx.agent.id, node.config.channel || "telegram", to, {
      text: String(render(node.config.text, s)),
      buttons: buttons.length ? buttons : undefined,
    });
    return { port: "out", output: { to, ...res } };
  },
});
