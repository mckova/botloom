import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { GoogleClient } from "../src/integrations/google.js";
import { resolveColumn } from "../src/engine/nodes/integrations.js";
import type { LlmProvider } from "../src/llm/provider.js";

let calls: { url: string; body?: any }[] = [];
const fakeFetch: typeof fetch = async (url: any, init?: any) => {
  calls.push({ url: String(url), body: init?.body });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

async function setup(llm?: LlmProvider) {
  calls = [];
  const store = new Store(":memory:");
  const built = await buildApp({ store, http: fakeFetch, llm, adminToken: "" });
  return { ...built, store };
}

const chat = async (app: any, agentId: string, text: string, extra: Record<string, any> = {}) =>
  (await app.inject({ method: "POST", url: `/api/agents/${agentId}/chat`, payload: { contactId: "u1", contactName: "Dana", text, ...extra } })).json();

const createAgent = async (app: any, flow: any, settings: any = { language: "en" }) =>
  (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "T", description: "", flow, settings } })).json();

const fromTemplate = async (app: any, id: string) => (await app.inject({ method: "POST", url: `/api/agents/from-template/${id}` })).json();

const node = (id: string, type: string, config: any = {}, x = 0) => ({ id, type, config, position: { x, y: 0 } });

describe("Google Sheets lookup", () => {
  it("resolves columns by letter, number and header name", () => {
    const rows = [["Name", "Phone"], ["Dana", "050"]];
    expect(resolveColumn(rows, "B").index).toBe(1);
    expect(resolveColumn(rows, "2").index).toBe(1);
    expect(resolveColumn(rows, "phone")).toEqual({ index: 1, headers: ["Name", "Phone"] });
  });

  it("finds a row the flow wrote earlier (sandbox) and routes found / notfound", async () => {
    const { app } = await setup();
    const agent = await createAgent(app, {
      nodes: [
        node("start", "trigger.message"),
        node("save", "google.sheets.append", { spreadsheetId: "s1", sheet: "Customers", columns: "Name\nPhone\nTier" }),
        node("save2", "google.sheets.append", { spreadsheetId: "s1", sheet: "Customers", columns: "Dana\n0501234567\nGold" }),
        node("find", "google.sheets.lookup", { spreadsheetId: "s1", sheet: "Customers", column: "Phone", value: "{{message.text}}", saveAs: "customer" }),
        node("yes", "message.send", { text: "Hi {{vars.customer.Name}}, tier {{vars.customer.Tier}}" }),
        node("no", "message.send", { text: "not found" }),
      ],
      edges: [
        { id: "e1", source: "start", target: "save" },
        { id: "e2", source: "save", target: "save2" },
        { id: "e3", source: "save2", target: "find" },
        { id: "e4", source: "find", target: "yes", sourcePort: "found" },
        { id: "e5", source: "find", target: "no", sourcePort: "notfound" },
      ],
    });
    let r = await chat(app, agent.id, "0501234567");
    expect(r.messages.at(-1).text).toBe("Hi Dana, tier Gold");
    r = await chat(app, agent.id, "0000000");
    expect(r.messages.at(-1).text).toBe("not found");
  });
});

describe("calendar availability", () => {
  it("excludes busy times and respects working hours", async () => {
    const store = new Store(":memory:");
    const g = new GoogleClient(store, {});
    await g.createEvent("a1", "primary", { summary: "x", start: "2026-11-03T10:00", durationMin: 30 });
    const slots = await g.freeSlots("a1", "primary", { from: "2026-11-03T00:00", to: "2026-11-04T00:00", durationMin: 30, dayStart: "09:00", dayEnd: "12:00", max: 10 });
    expect(slots).toEqual(["09:00", "09:30", "10:30", "11:00", "11:30"].map((t) => new Date(`2026-11-03T${t}`).toISOString().slice(0, 16)));
  });

  it("the guided booking path refuses a taken slot and asks for another time", async () => {
    const { app } = await setup();
    const agent = await fromTemplate(app, "clinic-receptionist");
    const book = async (contactId: string) => {
      const c = (text: string, extra: any = {}) => chat(app, agent.id, text, { contactId, ...extra });
      await c("שלום");
      await c("", { buttonId: "book" });
      await c("דנה כהן");
      await c("0501234567");
      return c("2026-11-03 10:30");
    };
    expect((await book("p1")).messages[0].text).toContain("נקבע תור");
    const second = await book("p2");
    expect(second.messages[0].text).toContain("תפוס");
    expect(second.run.status).toBe("waiting"); // back at the date question
  });

  it("the agent checks availability and will not double-book", async () => {
    const results: any[] = [];
    const llm: LlmProvider = {
      name: "scripted",
      classify: async () => null,
      extract: async () => ({}),
      json: async () => null,
      generate: async () => ({ text: "" }),
      async runAgent(req) {
        results.push(JSON.parse(await req.executeTool("check_availability", { from_date: "2026-11-05" })));
        results.push(JSON.parse(await req.executeTool("book_appointment", { full_name: "A", datetime: "2026-11-05T09:00" })));
        results.push(JSON.parse(await req.executeTool("book_appointment", { full_name: "B", datetime: "2026-11-05T09:00" })));
        return { text: "ok", toolCalls: [], provider: "scripted" };
      },
    };
    const { app } = await setup(llm);
    const agent = await fromTemplate(app, "clinic-receptionist");
    await chat(app, agent.id, "hi");
    await chat(app, agent.id, "", { buttonId: "question" });
    await chat(app, agent.id, "when are you free?");
    expect(results[0].slots[0]).toBe(new Date("2026-11-05T08:00").toISOString().slice(0, 16)); // template opens at 08:00
    expect(results[1].ok).toBe(true);
    expect(results[2]).toMatchObject({ ok: false });
    expect(results[2].message).toContain("already taken");
  });
});

describe("long-term contact memory", () => {
  it("saves preferences, refuses sensitive data, and brings them back after /restart", async () => {
    const systems: string[] = [];
    const llm: LlmProvider = {
      name: "scripted",
      classify: async () => null,
      extract: async () => ({}),
      json: async () => null,
      generate: async () => ({ text: "" }),
      async runAgent(req) {
        systems.push(req.system);
        if (req.userText.includes("prefer")) await req.executeTool("remember", { fact: "Prefers WhatsApp over email" });
        if (req.userText.includes("card")) {
          const refused = JSON.parse(await req.executeTool("remember", { fact: "card 4580123412341234" }));
          return { text: refused.message, toolCalls: [], provider: "scripted" };
        }
        return { text: "ok", toolCalls: [], provider: "scripted" };
      },
    };
    const { app } = await setup(llm);
    const agent = await fromTemplate(app, "ai-sales-agent");
    await chat(app, agent.id, "I prefer WhatsApp");
    expect((await chat(app, agent.id, "my card is 4580123412341234")).messages[0].text).toContain("Refused");
    await chat(app, agent.id, "/restart");
    expect(systems.at(-1)).toContain("Prefers WhatsApp over email");
    expect(systems.at(-1)).not.toContain("4580");
    const sessions = (await app.inject({ url: `/api/agents/${agent.id}/sessions` })).json();
    const mem = (await app.inject({ url: `/api/sessions/${sessions[0].id}/memory` })).json();
    expect(mem.map((m: any) => m.fact)).toEqual(["Prefers WhatsApp over email"]);
    await app.inject({ method: "DELETE", url: `/api/sessions/${sessions[0].id}/memory/${mem[0].id}` });
    expect((await app.inject({ url: `/api/sessions/${sessions[0].id}/memory` })).json()).toHaveLength(0);
  });

  it("the demo provider remembers explicit preferences", async () => {
    const { app } = await setup();
    const agent = await fromTemplate(app, "ai-sales-agent");
    const r = await chat(app, agent.id, "Remember that I always pay by bank transfer");
    expect(r.run.steps.at(-1).output.toolCalls[0].name).toBe("remember");
  });
});

describe("AI write node", () => {
  it("writes the order email with Claude and falls back to the plain email on error", async () => {
    const prompts: string[] = [];
    const llm: LlmProvider = {
      name: "scripted",
      classify: async () => null,
      extract: async () => ({}),
      json: async () => null,
      runAgent: async () => ({ text: "", toolCalls: [], provider: "scripted" }),
      async generate(prompt, opts) {
        prompts.push(`${opts?.system ?? ""}|${prompt}`);
        if (prompt.includes("FAIL")) throw new Error("overloaded");
        return { text: "Dear Noa, thank you!", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const { app, store } = await setup(llm);
    const agent = await fromTemplate(app, "order-automation");
    await app.inject({ method: "POST", url: `/hooks/${agent.id}/new-order`, payload: { id: "A-1", customer: "Noa", email: "noa@example.com", total: 90, items: ["cable"] } });
    expect(prompts[0]).toContain("Plain text");
    expect(prompts[0]).toContain('["cable"]');
    await app.inject({ method: "POST", url: `/hooks/${agent.id}/new-order`, payload: { id: "A-2", customer: "FAIL", email: "x@example.com", total: 10 } });
    const mails = store
      .listIntegrationLog(agent.id)
      .filter((l) => l.action === "gmail.send")
      .map((l) => Buffer.from(l.request.raw, "base64url").toString());
    expect(mails.some((m) => m.includes("Dear Noa, thank you!"))).toBe(true);
    expect(mails.some((m) => m.includes("Thanks for your order of $10"))).toBe(true);
  });
});

describe("team chat alerts", () => {
  it("posts to Slack and Discord webhooks and rejects other hosts", async () => {
    const { app, store } = await setup();
    const agent = await createAgent(app, {
      nodes: [
        node("start", "trigger.message"),
        node("s", "channel.notify", { channel: "slack", to: "https://hooks.slack.com/services/T/B/x", text: "lead {{message.text}}", buttons: "a: Call back" }),
        node("d", "channel.notify", { channel: "discord", to: "", text: "lead" }),
        node("bad", "channel.notify", { channel: "slack", to: "https://evil.example.com/hook", text: "x" }),
      ],
      edges: [
        { id: "e1", source: "start", target: "s" },
        { id: "e2", source: "s", target: "d" },
        { id: "e3", source: "d", target: "bad" },
      ],
    });
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/channels/discord`, payload: { config: { webhookUrl: "https://discord.com/api/webhooks/1/abc" } } });
    const r = await chat(app, agent.id, "Dana");
    expect(calls.map((c) => c.url)).toEqual(["https://hooks.slack.com/services/T/B/x", "https://discord.com/api/webhooks/1/abc"]);
    expect(JSON.parse(calls[0].body).text).toBe("lead Dana\n1. Call back");
    expect(JSON.parse(calls[1].body).content).toBe("lead");
    expect(r.run.steps.at(-1).output.delivered).toBe(false);
    const channels = (await app.inject({ url: `/api/agents/${agent.id}/channels` })).json();
    expect(channels[0].config.webhookUrl).toBe("http…/abc"); // masked
    expect(store.listIntegrationLog(agent.id).filter((l) => l.service === "slack" || l.service === "discord")).toHaveLength(2);
  });
});

describe("human inbox copilot", () => {
  it("briefs the team member on handoff and drafts a reply from the knowledge base", async () => {
    const { app } = await setup();
    const agent = await fromTemplate(app, "clinic-receptionist");
    await chat(app, agent.id, "היי");
    await chat(app, agent.id, "", { buttonId: "question" });
    await chat(app, agent.id, "כמה עולה טיפול? זה דחוף");
    const r = await chat(app, agent.id, "אני רוצה נציג");
    expect(r.run.status).toBe("handoff");
    const brief = r.session.vars.__brief;
    expect(brief).toMatchObject({ by: "rules", urgency: "high" });
    expect(brief.summary).toContain("כמה עולה טיפול");

    const sessions = (await app.inject({ url: `/api/agents/${agent.id}/sessions` })).json();
    const s = await app.inject({ method: "POST", url: `/api/sessions/${sessions[0].id}/suggest` });
    expect(s.statusCode).toBe(200);
    expect(typeof s.json().draft).toBe("string");

    await app.inject({ method: "POST", url: `/api/sessions/${sessions[0].id}/release` });
    const after = (await app.inject({ url: `/api/agents/${agent.id}/sessions` })).json();
    expect(after[0].vars.__brief).toBeUndefined();
  });

  it("uses Claude's structured brief when available", async () => {
    const llm: LlmProvider = {
      name: "scripted",
      classify: async () => null,
      extract: async () => ({}),
      generate: async () => ({ text: "" }),
      json: async (_p, schema: any) => (schema.required?.includes("nextStep") ? { summary: "Wants a refund", customerWants: "refund", sentiment: "upset", urgency: "high", nextStep: "Offer a refund" } : null),
      async runAgent(req) {
        await req.executeTool("handoff_to_human", { reason: "refund" });
        return { text: "Connecting you", toolCalls: [], provider: "scripted" };
      },
    };
    const { app } = await setup(llm);
    const agent = await fromTemplate(app, "ai-sales-agent");
    const r = await chat(app, agent.id, "I want my money back");
    expect(r.session.vars.__brief).toMatchObject({ by: "claude", nextStep: "Offer a refund" });
  });
});

describe("flow copilot (revise with AI)", () => {
  it("returns a validated proposal and does not save it", async () => {
    let request = "";
    const llm: LlmProvider = {
      name: "scripted",
      classify: async () => null,
      extract: async () => ({}),
      generate: async () => ({ text: "" }),
      runAgent: async () => ({ text: "", toolCalls: [], provider: "scripted" }),
      async json(prompt) {
        request = prompt;
        const draft = JSON.parse(prompt.match(/<current_agent>\n([\s\S]*?)\n<\/current_agent>/)![1]);
        draft.nodes.push({ id: "slackAlert", type: "channel.notify", label: "Slack", configJson: JSON.stringify({ channel: "slack", text: "New lead" }), x: 2, y: 2 });
        draft.edges.push({ source: "agent", target: "slackAlert", sourcePort: "handoff" });
        return { ...draft, knowledge: [], notes: ["Added a Slack alert on handoff"] };
      },
    };
    const { app } = await setup(llm);
    const agent = await fromTemplate(app, "ai-sales-agent");
    const res = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/revise`, payload: { instruction: "Also alert me on Slack when a human is needed" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(request).toContain("Also alert me on Slack");
    expect(body.notes[0]).toBe("Added a Slack alert on handoff");
    expect(body.flow.nodes.map((n: any) => n.id)).toContain("slackAlert");
    expect(body.flow.nodes.find((n: any) => n.id === "agent").config.tools).toContain("lookup_order"); // untouched config kept
    expect(body.validation.errors).toEqual([]);
    const saved = (await app.inject({ url: `/api/agents/${agent.id}` })).json();
    expect(saved.flow.nodes.map((n: any) => n.id)).not.toContain("slackAlert");
  });

  it("the demo editor adds an alert step for a simple request and the result validates", async () => {
    const { app } = await setup();
    const agent = await fromTemplate(app, "ai-sales-agent");
    const res = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/revise`, payload: { instruction: "alert me on Slack when someone asks for a human" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const added = body.flow.nodes.find((n: any) => n.id === "notify" && n.type === "channel.notify");
    expect(added.config.channel).toBe("slack");
    expect(body.flow.edges.some((e: any) => e.source === "agent" && e.sourcePort === "handoff" && e.target === "notify")).toBe(true);
    expect(body.validation.errors).toEqual([]);
    expect(body.notes.length).toBeGreaterThan(0);
  });

  it("explains that the copilot needs Claude in demo mode", async () => {
    const { app } = await setup();
    const agent = await fromTemplate(app, "ai-sales-agent");
    const res = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/revise`, payload: { instruction: "add a step" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("ANTHROPIC_API_KEY");
  });
});
