import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../src/llm/anthropic.js";

// Exercises the real SDK request/response cycle against a fake transport.
describe("AnthropicProvider tool loop", () => {
  it("runs tools, returns results in one user turn and sends the expected request shape", async () => {
    const bodies: any[] = [];
    const headers: Headers[] = [];
    const replies = [
      {
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", stop_sequence: null,
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu_1", name: "knowledge_search", input: { query: "hours" } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      {
        id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: "We're open 8-20." }],
        usage: { input_tokens: 150, output_tokens: 10 },
      },
    ];
    const fakeFetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      headers.push(new Headers(init.headers));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const p = new AnthropicProvider({ apiKey: "test-key", fetch: fakeFetch });
    const executed: string[] = [];
    const res = await p.runAgent({
      system: "You are a receptionist.",
      history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello!" }],
      userText: "When are you open?",
      tools: [{ name: "knowledge_search", description: "search", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
      executeTool: async (name, input) => {
        executed.push(`${name}:${input.query}`);
        return '{"results":[{"snippet":"8-20"}]}';
      },
    });

    expect(res.text).toBe("We're open 8-20.");
    expect(executed).toEqual(["knowledge_search:hours"]);
    expect(res.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
    expect(bodies[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(headers[0].get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    // Second request: full assistant content appended, then all tool results in one user message.
    const msgs = bodies[1].messages;
    expect(msgs.at(-2).role).toBe("assistant");
    expect(msgs.at(-2).content[1].type).toBe("tool_use");
    expect(msgs.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1" }] });
  });
});
