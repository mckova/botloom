// Claude provider. Manual tool-use loop because the tool set is assembled per agent at runtime
// and every tool call must be recorded in the run trace.
import Anthropic from "@anthropic-ai/sdk";
import type { AgentLoopRequest, AgentLoopResult, LlmProvider, ToolCallRecord } from "./provider.js";

export const DEFAULT_MODEL = process.env.BOTLOOM_MODEL ?? "claude-opus-5-5";

// Server-side fallback: if a request is declined by a safety classifier, the API re-runs it on a
// fallback model chosen by refusal category, inside the same call.
const BETAS = ["server-side-fallback-2026-07-01"];

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export class AnthropicProvider implements LlmProvider {
  name = "anthropic";
  private client: Anthropic;

  constructor(opts: { apiKey?: string; fetch?: typeof fetch } = {}) {
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async runAgent(req: AgentLoopRequest): Promise<AgentLoopResult> {
    const model = req.model || DEFAULT_MODEL;
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...req.history.map((h) => ({ role: h.role, content: h.text }) as Anthropic.Beta.BetaMessageParam),
      { role: "user", content: req.userText },
    ];
    const toolCalls: ToolCallRecord[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    const maxSteps = req.maxSteps ?? 6;

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: BETAS,
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "low" }, // chat assistant: low latency, low cost
        system: req.system,
        tools: req.tools.length ? req.tools : undefined,
        messages,
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      if (response.stop_reason === "refusal") {
        return { text: "Sorry, I can't help with that request.", toolCalls, provider: this.name, usage: { inputTokens, outputTokens } };
      }
      // Keep the full content (including thinking blocks) so the history stays append-only.
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn") continue;
      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || uses.length === 0) {
        return { text: textOf(response.content), toolCalls, provider: this.name, usage: { inputTokens, outputTokens } };
      }

      // Run all tool calls, then return every result in a single user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, any>;
        try {
          const result = await req.executeTool(use.name, input);
          toolCalls.push({ name: use.name, input, result });
          results.push({ type: "tool_result", tool_use_id: use.id, content: result });
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          toolCalls.push({ name: use.name, input, result: `ERROR: ${msg}` });
          results.push({ type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return { text: "I'm still working on that, could you rephrase?", toolCalls, provider: this.name, usage: { inputTokens, outputTokens } };
  }

  async json(prompt: string, schema: Record<string, unknown>, opts: { model?: string; system?: string; effort?: "low" | "medium" | "high" } = {}): Promise<any> {
    // Streaming + finalMessage: design requests can produce long outputs.
    const response = await this.client.beta.messages
      .stream({
        model: opts.model || DEFAULT_MODEL,
        max_tokens: 32000,
        betas: BETAS,
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort ?? "low", format: { type: "json_schema", schema } },
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: prompt }],
      })
      .finalMessage();
    if (response.stop_reason === "refusal") return null;
    try {
      return JSON.parse(textOf(response.content));
    } catch {
      return null;
    }
  }

  async classify(text: string, labels: { id: string; description: string }[], model?: string) {
    const ids = [...labels.map((l) => l.id), "none"];
    const out = await this.json(
      `Classify the user's message into exactly one intent.\n\nIntents:\n${labels
        .map((l) => `- ${l.id}: ${l.description}`)
        .join("\n")}\n- none: nothing above fits\n\nUser message:\n<message>${text}</message>`,
      {
        type: "object",
        properties: { intent: { type: "string", enum: ids } },
        required: ["intent"],
        additionalProperties: false,
      },
      { model },
    );
    const intent = out?.intent;
    return intent && intent !== "none" ? intent : null;
  }

  async extract(text: string, fields: { name: string; description: string }[], model?: string) {
    const properties: Record<string, any> = {};
    for (const f of fields) properties[f.name] = { type: ["string", "null"], description: f.description };
    const out = await this.json(
      `Extract the fields below from the text. Use null for anything not stated. Do not invent values.\n\n<text>${text}</text>`,
      { type: "object", properties, required: fields.map((f) => f.name), additionalProperties: false },
      { model },
    );
    const result: Record<string, string | null> = {};
    for (const f of fields) result[f.name] = out?.[f.name] ?? null;
    return result;
  }
}
