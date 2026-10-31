import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { Store } from "../src/db.js";

async function setup() {
  const store = new Store(":memory:");
  const built = await buildApp({ store, adminToken: "" });
  return { ...built, store };
}
const chat = async (app: any, agentId: string, contactId: string, text: string) =>
  (await app.inject({ method: "POST", url: `/api/agents/${agentId}/chat`, payload: { contactId, contactName: contactId, text } })).json();
const fromTemplate = async (app: any, id: string) => (await app.inject({ method: "POST", url: `/api/agents/from-template/${id}` })).json();
const inbox = async (app: any, q = "") => (await app.inject({ url: `/api/inbox${q}` })).json();

describe("shared inbox", () => {
  it("lists waiting chats across agents, oldest first, with folder counts", async () => {
    const { app } = await setup();
    const a = await fromTemplate(app, "ai-sales-agent");
    const b = await fromTemplate(app, "ai-sales-agent");
    await chat(app, a.id, "dana", "What is your return policy?");
    await chat(app, a.id, "noa", "I want a human please");
    await new Promise((r) => setTimeout(r, 5));
    await chat(app, b.id, "omer", "Can I talk to a human?");

    const box = await inbox(app);
    expect(box.counts).toMatchObject({ waiting: 2, handled: 1, all: 3 });
    expect(box.items.map((i: any) => i.contactName)).toEqual(["noa", "omer"]);
    expect(box.items[0]).toMatchObject({ agentName: a.name, handoff: true, lastText: "I want a human please" });
    expect(box.counts.agents.find((x: any) => x.id === b.id).waiting).toBe(1);

    expect((await inbox(app, "?filter=handled")).items.map((i: any) => i.contactName)).toEqual(["dana"]);
    expect((await inbox(app, `?filter=all&agent=${b.id}`)).items).toHaveLength(1);
  });

  it("send and hand back clears the waiting state", async () => {
    const { app } = await setup();
    const a = await fromTemplate(app, "ai-sales-agent");
    await chat(app, a.id, "noa", "human please");
    const [item] = (await inbox(app)).items;
    const detail = (await app.inject({ url: `/api/sessions/${item.id}` })).json();
    expect(detail.agentName).toBe(a.name);
    expect(detail.brief?.summary).toBeTruthy();
    await app.inject({ method: "POST", url: `/api/sessions/${item.id}/reply`, payload: { text: "Hi Noa, Dana here." } });
    await app.inject({ method: "POST", url: `/api/sessions/${item.id}/release` });
    const box = await inbox(app);
    expect(box.counts.waiting).toBe(0);
    const why = (await app.inject({ url: `/api/sessions/${item.id}/explain` })).json();
    expect(why.at(-1)).toMatchObject({ source: "team" });
  });
});

describe("why this answer", () => {
  it("names the note and quotes the passage the agent answered from", async () => {
    const { app } = await setup();
    const a = await fromTemplate(app, "ai-sales-agent");
    await chat(app, a.id, "dana", "How long does express shipping take?");
    const [item] = (await inbox(app, "?filter=all")).items;
    const why = (await app.inject({ url: `/api/sessions/${item.id}/explain` })).json();
    const k = why.find((w: any) => w.source === "knowledge");
    expect(k).toBeTruthy();
    expect(k.summary).toMatch(/^Answered from the .+ note$/);
    expect(k.doc.id).toMatch(/^doc_/);
    expect(k.doc.quote).toMatch(/^Shipping: free shipping/);
  });

  it("explains fixed messages and handoffs", async () => {
    const { app } = await setup();
    const a = await fromTemplate(app, "ai-sales-agent");
    await chat(app, a.id, "noa", "I want a human");
    const [item] = (await inbox(app)).items;
    const why = (await app.inject({ url: `/api/sessions/${item.id}/explain` })).json();
    expect(why.some((w: any) => w.source === "handoff")).toBe(true);
  });
});

describe("knowledge edits from the inbox", () => {
  it("edits a note and teaches a correction the agent then finds", async () => {
    const { app } = await setup();
    const a = await fromTemplate(app, "ai-sales-agent");
    const docs = (await app.inject({ url: `/api/agents/${a.id}/docs` })).json();
    const r = await app.inject({ method: "PUT", url: `/api/docs/${docs[0].id}`, payload: { content: "Returns within 60 days." } });
    expect(r.json()).toMatchObject({ id: docs[0].id, title: docs[0].title, content: "Returns within 60 days." });
    expect((await app.inject({ method: "PUT", url: `/api/docs/${docs[0].id}`, payload: { content: " " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/docs/doc_missing", payload: { content: "x" } })).statusCode).toBe(404);

    const t = (
      await app.inject({ method: "POST", url: `/api/agents/${a.id}/teach`, payload: { question: "Do you ship to Cyprus?", answer: "Yes, in 5 to 7 days." } })
    ).json();
    expect(t.title).toBe("Correction: Do you ship to Cyprus?");
    const reply = await chat(app, a.id, "dana", "Do you ship to Cyprus?");
    const kb = reply.run.steps.at(-1).output.toolCalls.find((c: any) => c.name === "knowledge_search");
    expect(JSON.parse(kb.result).results[0].title).toBe(t.title);
  });
});

describe("demo data", () => {
  it("fills an empty workspace once with agents and a waiting conversation", async () => {
    const { seedDemo } = await import("../src/demo-seed.js");
    const { app, store } = await setup();
    expect(await seedDemo(app, store)).toBe(true);
    expect(store.listAgents()).toHaveLength(3);
    const box = await inbox(app);
    expect(box.counts.waiting).toBe(2);
    expect(box.counts.all).toBeGreaterThanOrEqual(4);
    expect(await seedDemo(app, store)).toBe(false);
  });
});
