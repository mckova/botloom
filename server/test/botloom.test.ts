import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { render } from "../src/engine/template.js";
import { chunk, search } from "../src/knowledge/bm25.js";
import { parseTelegram, parseWhatsApp, whatsappPayload } from "../src/channels/hub.js";
import { dueTriggers } from "../src/scheduler.js";
import { assertPublicUrl } from "../src/engine/nodes/integrations.js";
import type { LlmProvider } from "../src/llm/provider.js";

const fakeFetch: typeof fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, body: init?.body });
  if (u.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  return new Response(JSON.stringify({ ok: true, echo: init?.body ? JSON.parse(init.body) : null }), { status: 200 });
};
let calls: { url: string; body?: any }[] = [];

async function setup(llm?: LlmProvider) {
  calls = [];
  const store = new Store(":memory:");
  const built = await buildApp({ store, http: fakeFetch, llm, adminToken: "" });
  return built;
}

async function chat(app: any, agentId: string, text: string, extra: Record<string, any> = {}) {
  const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/chat`, payload: { contactId: "u1", contactName: "Dana", text, ...extra } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function fromTemplate(app: any, id: string) {
  const res = await app.inject({ method: "POST", url: `/api/agents/from-template/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("template engine", () => {
  it("renders paths, filters and blocks prototype access", () => {
    const scope = { vars: { name: "dana", list: [1, 2] }, contact: { name: "" } };
    expect(render("Hi {{vars.name | upper}}", scope)).toBe("Hi DANA");
    expect(render("{{vars.list}}", scope)).toEqual([1, 2]);
    expect(render("{{contact.name | default: 'friend'}}", scope)).toBe("friend");
    expect(render("{{vars.__proto__}}", scope)).toBeUndefined();
    expect(render("{{vars.constructor.name}}", scope)).toBeUndefined();
  });
});

describe("knowledge base", () => {
  it("retrieves Hebrew passages with prefix stripping", () => {
    const chunks = chunk("d1", "מרפאה", "שעות פעילות: ראשון עד חמישי 08:00-20:00.\n\nמחירים: טיפול 280 ש\"ח.\n\nביטול תור עד 24 שעות לפני.");
    const hits = search(chunks, "מה המחירים לטיפול?");
    expect(hits[0].text).toContain("280");
  });
});

describe("clinic template, end to end through the API", () => {
  let built: Awaited<ReturnType<typeof setup>>;
  let agent: any;
  beforeEach(async () => {
    built = await setup();
    agent = await fromTemplate(built.app, "clinic-receptionist");
  });

  it("books an appointment with validation, Calendar, Telegram alert and Sheets row", async () => {
    const app = built.app;
    let r = await chat(app, agent.id, "שלום");
    expect(r.messages[0].text).toContain("שלום");
    expect(r.messages[0].buttons.map((b: any) => b.id)).toEqual(["book", "question", "human"]);
    expect(r.run.status).toBe("waiting");

    r = await chat(app, agent.id, "", { buttonId: "book" });
    expect(r.messages[0].text).toContain("השם");
    r = await chat(app, agent.id, "דנה כהן");
    r = await chat(app, agent.id, "abc");
    expect(r.messages[0].text).toContain("לא נראה תקין"); // retry message, still waiting
    r = await chat(app, agent.id, "050-1234567");
    r = await chat(app, agent.id, "2026-11-03 10:30");
    expect(r.run.status).toBe("completed");
    expect(r.messages[0].text).toContain("נקבע תור לדנה כהן");
    expect(r.session.vars).toMatchObject({ full_name: "דנה כהן", phone: "050-1234567", datetime: "2026-11-03 10:30" });

    const log = (await app.inject({ url: `/api/agents/${agent.id}/integrations-log` })).json();
    const actions = log.map((l: any) => `${l.service}:${l.action}`);
    expect(actions).toContain("google:calendar.create");
    expect(actions).toContain("google:sheets.append");
    expect(actions).toContain("telegram:send"); // not connected, so logged in sandbox
    const types = r.run.steps.map((s: any) => s.type);
    expect(types).toEqual(["message.ask", "google.calendar.create", "message.send", "channel.notify", "google.sheets.append"]);
  });

  it("accepts a numbered answer and answers questions from the knowledge base", async () => {
    const app = built.app;
    await chat(app, agent.id, "היי");
    let r = await chat(app, agent.id, "2"); // numbered choice -> question
    expect(r.messages[0].text).toContain("מה השאלה");
    r = await chat(app, agent.id, "כמה עולה טיפול פיזיותרפיה?");
    expect(r.messages[0].text).toContain("280");
    expect(r.run.steps.at(-1).output.toolCalls[0].name).toBe("knowledge_search");
  });

  it("stays silent during human handoff until released", async () => {
    const app = built.app;
    await chat(app, agent.id, "היי");
    let r = await chat(app, agent.id, "", { buttonId: "human" });
    expect(r.run.status).toBe("handoff");
    r = await chat(app, agent.id, "hello?");
    expect(r.messages).toHaveLength(0);
    const sessions = (await app.inject({ url: `/api/agents/${agent.id}/sessions` })).json();
    await app.inject({ method: "POST", url: `/api/sessions/${sessions[0].id}/release` });
    r = await chat(app, agent.id, "שלום");
    expect(r.messages[0].buttons).toHaveLength(3);
  });

  it("restarts the conversation on /restart", async () => {
    const app = built.app;
    await chat(app, agent.id, "היי");
    await chat(app, agent.id, "", { buttonId: "book" });
    const r = await chat(app, agent.id, "/restart");
    expect(r.messages[0].buttons).toHaveLength(3);
  });
});

describe("automation template (webhook)", () => {
  it("logs the order, emails the customer and flags VIP orders", async () => {
    const built = await setup();
    const agent = await fromTemplate(built.app, "order-automation");
    let res = await built.app.inject({ method: "POST", url: `/hooks/${agent.id}/new-order`, payload: { id: "A-17", customer: "Noa", email: "noa@example.com", total: 720 } });
    expect(res.json().status).toBe("completed");
    res = await built.app.inject({ method: "POST", url: `/hooks/${agent.id}/new-order`, payload: { id: "A-18", customer: "Ben", email: "ben@example.com", total: 40 } });
    const log = (await built.app.inject({ url: `/api/agents/${agent.id}/integrations-log` })).json();
    const vip = log.filter((l: any) => l.service === "telegram");
    expect(vip).toHaveLength(1);
    expect(vip[0].request.msg.text).toContain("A-17");
    expect(log.filter((l: any) => l.action === "gmail.send")).toHaveLength(2);
    expect((await built.app.inject({ method: "POST", url: `/hooks/${agent.id}/nope`, payload: {} })).statusCode).toBe(404);
  });
});

describe("AI agent tool gating", () => {
  it("records tool calls in the trace and refuses tools that are not allowed", async () => {
    const scripted: LlmProvider = {
      name: "scripted",
      async runAgent(req) {
        const ok = await req.executeTool("save_lead", { full_name: "Omer", phone: "0521111111" });
        let denied = "";
        try {
          await req.executeTool("send_email", { to: "x@y.z", subject: "s", body: "b" });
        } catch (e: any) {
          denied = e.message;
        }
        return { text: `saved; ${denied}`, toolCalls: [{ name: "save_lead", input: {}, result: ok }], provider: "scripted" };
      },
      async classify() {
        return null;
      },
      async json() {
        return null;
      },
      async extract() {
        return {};
      },
    };
    const built = await setup(scripted);
    const agent = await fromTemplate(built.app, "ai-sales-agent");
    const r = await chat(built.app, agent.id, "I want a quote");
    expect(r.messages[0].text).toContain("not allowed");
    expect(r.session.vars.lead_name).toBe("Omer");
    expect(r.run.status).toBe("waiting"); // agent stays in the conversation
  });

  it("mock agent escalates to a human and notifies the team", async () => {
    const built = await setup();
    const agent = await fromTemplate(built.app, "ai-sales-agent");
    const r = await chat(built.app, agent.id, "I want to talk to a human please");
    expect(r.run.status).toBe("handoff");
    expect(r.messages.map((m: any) => m.text).join(" ")).toContain("teammate");
  });
});

describe("channels", () => {
  it("parses Telegram messages and button presses", () => {
    expect(parseTelegram({ message: { chat: { id: 42 }, from: { first_name: "Avi" }, text: "hi" } })).toMatchObject({ contactId: "42", text: "hi", contactName: "Avi" });
    expect(parseTelegram({ callback_query: { id: "q", data: "book", from: { id: 7, first_name: "Avi" }, message: { chat: { id: 42 } } } })).toMatchObject({ buttonId: "book", contactId: "42" });
  });

  it("parses WhatsApp payloads and downgrades buttons", () => {
    const events = parseWhatsApp({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "9725", profile: { name: "Lior" } }], messages: [{ from: "9725", text: { body: "שלום" } }] } }] }] });
    expect(events[0]).toMatchObject({ channel: "whatsapp", contactId: "9725", contactName: "Lior", text: "שלום" });
    const three = whatsappPayload("1", { text: "pick", buttons: [1, 2, 3].map((i) => ({ id: `b${i}`, label: `B${i}` })) });
    expect(three.type).toBe("interactive");
    const many = whatsappPayload("1", { text: "pick", buttons: Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, label: `B${i}` })) });
    expect(many.type).toBe("text");
    expect((many as any).text.body).toContain("12. B11");
  });

  it("verifies WhatsApp webhooks and signatures, then replies through the Cloud API", async () => {
    const built = await setup();
    const agent = await fromTemplate(built.app, "clinic-receptionist");
    await built.app.inject({ method: "PUT", url: `/api/agents/${agent.id}/channels/whatsapp`, payload: { config: { phoneNumberId: "123", accessToken: "EAAtoken123456", verifyToken: "verify-me", appSecret: "s3cret" } } });
    const ok = await built.app.inject({ url: `/webhooks/whatsapp/${agent.id}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777` });
    expect(ok.body).toBe("777");
    const bad = await built.app.inject({ url: `/webhooks/whatsapp/${agent.id}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1` });
    expect(bad.statusCode).toBe(403);

    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "972500000000", text: { body: "היי" } }] } }] }] });
    const unsigned = await built.app.inject({ method: "POST", url: `/webhooks/whatsapp/${agent.id}`, headers: { "content-type": "application/json" }, payload: body });
    expect(unsigned.statusCode).toBe(401);
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    const signed = await built.app.inject({ method: "POST", url: `/webhooks/whatsapp/${agent.id}`, headers: { "content-type": "application/json", "x-hub-signature-256": sig }, payload: body });
    expect(signed.statusCode).toBe(200);
    const sent = calls.find((c) => c.url.includes("graph.facebook.com/v21.0/123/messages"));
    expect(JSON.parse(sent!.body).interactive.action.buttons).toHaveLength(3);

    const masked = (await built.app.inject({ url: `/api/agents/${agent.id}/channels` })).json();
    expect(masked[0].config.accessToken).not.toContain("token123");
  });

  it("checks the Telegram secret header", async () => {
    const built = await setup();
    const agent = await fromTemplate(built.app, "clinic-receptionist");
    await built.app.inject({ method: "PUT", url: `/api/agents/${agent.id}/channels/telegram`, payload: { config: { botToken: "123:ABCDEF" } } });
    const update = { message: { chat: { id: 5 }, from: { first_name: "Yael" }, text: "hi" } };
    expect((await built.app.inject({ method: "POST", url: `/webhooks/telegram/${agent.id}`, payload: update })).statusCode).toBe(401);
    const secret = built.store.listChannels(agent.id)[0].config.webhookSecret;
    const ok = await built.app.inject({ method: "POST", url: `/webhooks/telegram/${agent.id}`, headers: { "x-telegram-bot-api-secret-token": secret }, payload: update });
    expect(ok.statusCode).toBe(200);
    expect(calls.some((c) => c.url.endsWith("/bot123:ABCDEF/sendMessage"))).toBe(true);
  });
});

describe("safety and validation", () => {
  it("rejects flows with unknown node types", async () => {
    const built = await setup();
    const res = await built.app.inject({ method: "POST", url: "/api/agents", payload: { name: "x", flow: { nodes: [{ id: "a", type: "shell.exec", config: {} }], edges: [] } } });
    expect(res.statusCode).toBe(400);
  });

  it("blocks HTTP requests to private addresses", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data")).toThrow(/Blocked/);
    expect(() => assertPublicUrl("http://localhost:8787/api")).toThrow(/Blocked/);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow();
    expect(assertPublicUrl("https://api.example.com/x").hostname).toBe("api.example.com");
  });

  it("requires the admin token on the builder API when configured", async () => {
    const store = new Store(":memory:");
    const { app } = await buildApp({ store, http: fakeFetch, adminToken: "t0ken" });
    expect((await app.inject({ url: "/api/agents" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/agents", headers: { authorization: "Bearer t0ken" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
  });
});

describe("scheduler", () => {
  it("fires daily triggers once per day and interval triggers after the interval", async () => {
    const built = await setup();
    const agent = await fromTemplate(built.app, "order-automation");
    built.store.saveAgent({
      ...agent,
      flow: { ...agent.flow, nodes: [...agent.flow.nodes, { id: "tick", type: "trigger.schedule", config: { mode: "interval", minutes: 5 } }] },
    });
    const last = new Map<string, number>();
    const t = (h: number, m: number) => new Date(2026, 10, 2, h, m);
    expect(dueTriggers(built.store, last, t(7, 0))).toHaveLength(0); // arms interval timer
    const at8 = dueTriggers(built.store, last, t(8, 1));
    expect(at8.map((d) => d.nodeId).sort()).toEqual(["daily", "tick"]);
    for (const d of at8) last.set(`${d.agentId}:${d.nodeId}`, t(8, 1).getTime());
    expect(dueTriggers(built.store, last, t(8, 3))).toHaveLength(0);
    expect(dueTriggers(built.store, last, t(8, 7)).map((d) => d.nodeId)).toEqual(["tick"]);
  });
});
