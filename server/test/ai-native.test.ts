import { describe, it, expect } from "vitest";
import { buildApp, validateFlow } from "../src/app.js";
import { Store } from "../src/db.js";
import { aiPlaceholders } from "../src/engine/nodes/ai.js";
import { designAgent } from "../src/ai/designer.js";
import type { LlmProvider } from "../src/llm/provider.js";

const okFetch: typeof fetch = async () => new Response("{}", { status: 200 });
const base: Omit<LlmProvider, "runAgent" | "json"> = {
  name: "scripted",
  classify: async () => null,
  extract: async () => ({}),
};

describe("AI-filled parameters (flow nodes as agent tools)", () => {
  it("extracts {{ai.x}} placeholders with descriptions", () => {
    expect(aiPlaceholders({ columns: "{{ai.full_name | desc: 'customer name'}}\n{{ai.phone}}\n{{vars.x}}" })).toEqual([
      { name: "full_name", description: "customer name" },
      { name: "phone", description: "phone" },
    ]);
  });

  it("lets the agent call a Sheets node with values it fills in", async () => {
    let seenTools: string[] = [];
    const llm: LlmProvider = {
      ...base,
      json: async () => null,
      async runAgent(req) {
        seenTools = req.tools.map((t) => t.name);
        const schema = req.tools.find((t) => t.name === "flow_crm")!.input_schema;
        expect(schema.required).toEqual(["full_name", "phone"]);
        const r = await req.executeTool("flow_crm", { full_name: "Lior", phone: "0501112222" });
        return { text: `ok ${r}`, toolCalls: [], provider: "scripted" };
      },
    };
    const store = new Store(":memory:");
    const { app } = await buildApp({ store, llm, http: okFetch, adminToken: "" });
    const flow = {
      nodes: [
        { id: "start", type: "trigger.message", config: {} },
        { id: "agent", type: "ai.agent", config: { tools: [], flowTools: "crm", loop: false } },
        { id: "crm", type: "google.sheets.append", label: "Save to CRM", config: { spreadsheetId: "s1", sheet: "CRM", columns: "{{ai.full_name}}\n{{ai.phone}}" } },
      ],
      edges: [{ id: "e1", source: "start", target: "agent" }],
    };
    const created = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "t", flow } });
    const agent = created.json();
    const v = (await app.inject({ url: `/api/agents/${agent.id}` })).json().validation;
    expect(v.warnings.join(" ")).not.toContain("crm"); // tool nodes are not "unreachable"
    const r = (await app.inject({ method: "POST", url: `/api/agents/${agent.id}/chat`, payload: { contactId: "c1", text: "save me" } })).json();
    expect(seenTools).toContain("flow_crm");
    expect(r.messages[0].text).toContain('"port":"out"');
    const log = store.listIntegrationLog(agent.id);
    expect(log[0].request.values[0]).toEqual(["Lior", "0501112222"]);
  });
});

describe("graph analysis", () => {
  it("warns about loops that never wait and unreachable nodes", () => {
    const v = validateFlow({
      nodes: [
        { id: "t", type: "trigger.message", config: {} },
        { id: "a", type: "logic.set", config: {} },
        { id: "b", type: "logic.condition", config: {} },
        { id: "orphan", type: "message.send", config: {} },
      ],
      edges: [
        { id: "1", source: "t", target: "a" },
        { id: "2", source: "a", target: "b" },
        { id: "3", source: "b", target: "a", sourcePort: "true" },
      ],
    });
    expect(v.warnings.some((w) => w.startsWith("Loop without a waiting step"))).toBe(true);
    expect(v.warnings).toContain("Node orphan is not reachable from any trigger");
  });
});

describe("AI flow designer", () => {
  it("repairs its own draft when the validator finds problems", async () => {
    const drafts = [
      // First draft: edge from a port that does not exist.
      { nodes: [{ id: "start", type: "trigger.message", label: "Start", configJson: "{}", x: 0, y: 0 }, { id: "hi", type: "message.send", label: "Hi", configJson: '{"text":"שלום"}', x: 1, y: 0 }], edges: [{ source: "start", target: "hi", sourcePort: "yes" }] },
      { nodes: [{ id: "start", type: "trigger.message", label: "Start", configJson: "{}", x: 0, y: 0 }, { id: "hi", type: "message.send", label: "Hi", configJson: '{"text":"שלום"}', x: 1, y: 0 }], edges: [{ source: "start", target: "hi", sourcePort: "out" }] },
    ];
    const prompts: string[] = [];
    const llm: LlmProvider = {
      ...base,
      runAgent: async () => ({ text: "", toolCalls: [], provider: "x" }),
      async json(prompt) {
        prompts.push(prompt);
        return { name: "בוט", description: "d", language: "he", systemPrompt: "p", knowledge: [{ title: "FAQ", content: "x" }], notes: ["connect WhatsApp"], ...drafts[prompts.length - 1] };
      },
    };
    const d = await designAgent(llm, "בוט שאומר שלום", validateFlow);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("unknown port");
    expect(d.designer).toBe("claude");
    expect(d.flow.edges[0].sourcePort).toBe("out");
    expect(d.docs[0].title).toBe("FAQ");
  });

  it("falls back to the closest template in demo mode and saves the agent", async () => {
    const { app } = await buildApp({ store: new Store(":memory:"), http: okFetch, adminToken: "" });
    const r = await app.inject({ method: "POST", url: "/api/agents/design", payload: { prompt: "בוט למספרה שקובע תורים ביומן" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().designer).toBe("template-match");
    expect(r.json().agent.flow.nodes.some((n: any) => n.type === "google.calendar.create")).toBe(true);
  });
});

describe("web widget", () => {
  it("restores a returning visitor's conversation", async () => {
    const { app } = await buildApp({ store: new Store(":memory:"), http: okFetch, adminToken: "" });
    const agent = (await app.inject({ method: "POST", url: "/api/agents/from-template/clinic-receptionist" })).json();
    await app.inject({ method: "POST", url: `/widget/${agent.id}/message`, payload: { visitorId: "v-abcdef1", text: "" } });
    await app.inject({ method: "POST", url: `/widget/${agent.id}/message`, payload: { visitorId: "v-abcdef1", text: "1" } });
    const h = (await app.inject({ url: `/widget/${agent.id}/history?visitorId=v-abcdef1` })).json();
    expect(h.history.map((m: any) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(h.waiting).toBe(true);
  });
});
