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
  icon: "globe",
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
  icon: "sheet",
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
  type: "google.sheets.lookup",
  category: "integration",
  label: "Google Sheets: find row",
  description: "Finds the first row whose column matches a value (customer record, order status, price list) and saves it as a variable.",
  icon: "table-properties",
  fields: [
    { key: "spreadsheetId", label: "Spreadsheet id", kind: "text" },
    { key: "sheet", label: "Tab", kind: "text", default: "Sheet1" },
    { key: "column", label: "Column to search (letter, number or header name)", kind: "text", default: "A" },
    { key: "value", label: "Value to find", kind: "text", default: "{{vars.phone}}" },
    { key: "match", label: "Match", kind: "select", default: "exact", options: [{ value: "exact", label: "Exact (case-insensitive)" }, { value: "contains", label: "Contains" }] },
    { key: "saveAs", label: "Save row to variable", kind: "text", default: "row" },
  ],
  ports: () => ["found", "notfound", "error"],
  run: async (ctx, node) => {
    const c = node.config;
    const needle = String(render(c.value ?? "", ctx.scope()) ?? "").trim().toLowerCase();
    try {
      const rows = await ctx.services.google.readRows(ctx.agent.id, c.spreadsheetId || "demo-sheet", c.sheet || "Sheet1");
      const { index, headers } = resolveColumn(rows, String(c.column ?? "A"));
      const hit = needle
        ? rows.find((r, i) => (i > 0 || !headers) && matches(String(r[index] ?? ""), needle, c.match))
        : undefined;
      if (!hit) return { port: "notfound", output: { searched: rows.length, value: needle } };
      const record: Record<string, string> = {};
      hit.forEach((v, i) => (record[headers?.[i] || String.fromCharCode(65 + i)] = v));
      ctx.session.vars[c.saveAs || "row"] = record;
      return { port: "found", output: record };
    } catch (err: any) {
      return { port: "error", output: { error: err.message } };
    }
  },
});

/** A column given as a letter (B), a 1-based number (2) or a header name ("Phone"). */
export function resolveColumn(rows: string[][], col: string): { index: number; headers?: string[] } {
  const header = rows[0] ?? [];
  const byName = header.findIndex((h) => h.trim().toLowerCase() === col.trim().toLowerCase());
  if (byName >= 0 && !/^[A-Z]$/i.test(col.trim())) return { index: byName, headers: header.map((h) => h.trim()) };
  if (/^\d+$/.test(col)) return { index: Number(col) - 1 };
  if (/^[A-Z]$/i.test(col.trim())) return { index: col.trim().toUpperCase().charCodeAt(0) - 65 };
  return { index: 0 };
}

const matches = (cell: string, needle: string, mode?: string) => {
  const v = cell.trim().toLowerCase();
  return mode === "contains" ? v.includes(needle) : v === needle;
};

defineNode({
  type: "google.calendar.create",
  category: "integration",
  label: "Google Calendar: create event",
  description: "Creates a calendar event (appointments, meetings, reminders).",
  icon: "calendar-plus",
  fields: [
    { key: "calendarId", label: "Calendar id", kind: "text", default: "primary" },
    { key: "summary", label: "Title", kind: "text", default: "Meeting with {{vars.full_name}}" },
    { key: "start", label: "Start (ISO date-time)", kind: "text", default: "{{vars.datetime}}" },
    { key: "durationMin", label: "Duration (minutes)", kind: "number", default: 30 },
    { key: "attendee", label: "Attendee email", kind: "text", default: "{{vars.email}}" },
    { key: "checkBusy", label: "Refuse times that are already taken (busy port)", kind: "boolean", default: true },
  ],
  ports: (c) => (c.checkBusy === false ? ["out", "error"] : ["out", "busy", "error"]),
  run: async (ctx, node) => {
    const s = ctx.scope();
    const c = node.config;
    try {
      if (c.checkBusy !== false) {
        const start = new Date(String(render(c.start, s)));
        if (!isNaN(start.getTime())) {
          const dur = Number(c.durationMin ?? 30);
          const free = await ctx.services.google.freeSlots(ctx.agent.id, c.calendarId || "primary", {
            from: start.toISOString(),
            to: new Date(start.getTime() + dur * 60_000).toISOString(),
            durationMin: dur,
            dayStart: "00:00",
            dayEnd: "23:59",
            max: 1,
          });
          if (!free.length) return { port: "busy", output: { busy: true, start: start.toISOString() } };
        }
      }
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
  icon: "mail",
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
  description: "Sends a message to a Telegram chat, a WhatsApp number, or a Slack / Discord channel (incoming webhook), e.g. alert the team about a new lead.",
  icon: "megaphone",
  fields: [
    { key: "channel", label: "Channel", kind: "select", default: "telegram", options: ["telegram", "whatsapp", "slack", "discord"].map((v) => ({ value: v, label: v })) },
    { key: "to", label: "Chat id / phone number / webhook URL", kind: "text", help: "For Slack and Discord paste the incoming-webhook URL, or leave empty to use the one saved in Channels." },
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
