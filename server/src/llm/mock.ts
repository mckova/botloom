// Deterministic offline "LLM". Lets the whole platform (demo, tests, CI) run with no API key.
// It is intentionally simple: keyword matching for intents and tools, regexes for extraction.
import type { AgentLoopRequest, AgentLoopResult, LlmProvider, ToolCallRecord } from "./provider.js";

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /(\+?\d[\d\s-]{7,}\d)/;
const DATE = /\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/;
const NAME = /(?:my name is|i am|i'm|קוראים לי|שמי|אני)\s+([\p{L}]+(?:\s[\p{L}]+)?)/iu;

export function mockExtractValue(field: string, text: string): string | null {
  const f = field.toLowerCase();
  if (f.includes("email")) return text.match(EMAIL)?.[0] ?? null;
  if (f.includes("phone") || f.includes("tel")) return text.match(PHONE)?.[1]?.replace(/\s/g, "") ?? null;
  if (f.includes("date") || f.includes("time")) {
    const m = text.match(DATE);
    return m ? (m[2] ? `${m[1]}T${m[2].padStart(5, "0")}` : m[1]) : null;
  }
  if (f.includes("name")) return text.match(NAME)?.[1] ?? null;
  return null;
}

export class MockProvider implements LlmProvider {
  name = "mock";

  async runAgent(req: AgentLoopRequest): Promise<AgentLoopResult> {
    const toolCalls: ToolCallRecord[] = [];
    const words = new Set(tokenize(req.userText));
    const call = async (name: string, input: Record<string, any>) => {
      const result = await req.executeTool(name, input);
      toolCalls.push({ name, input, result });
      return result;
    };

    // 1. Handoff if the user asks for a human.
    const handoff = req.tools.find((t) => t.name === "handoff_to_human");
    if (handoff && /human|agent|representative|נציג|אדם/i.test(req.userText)) {
      await call("handoff_to_human", { reason: "User asked for a human" });
      return { text: "Connecting you with a team member now.", toolCalls, provider: this.name };
    }

    // 2. Any non-KB tool whose keywords appear in the message gets called with extracted args.
    for (const tool of req.tools) {
      if (tool.name === "knowledge_search" || tool.name === "handoff_to_human") continue;
      const keys = tokenize(`${tool.name.replace(/_/g, " ")} ${tool.description}`);
      if (!keys.some((k) => k.length > 3 && words.has(k))) continue;
      const input: Record<string, any> = {};
      for (const prop of Object.keys(tool.input_schema.properties)) {
        input[prop] = mockExtractValue(prop, req.userText) ?? (prop.includes("note") || prop.includes("summary") ? req.userText : null);
      }
      const missing = (tool.input_schema.required ?? []).filter((r) => !input[r]);
      if (missing.length) {
        return { text: `Sure. To do that I need your ${missing.join(", ").replace(/_/g, " ")}.`, toolCalls, provider: this.name };
      }
      const result = await call(tool.name, input);
      return { text: `Done. ${summarize(result)}`, toolCalls, provider: this.name };
    }

    // 3. Knowledge base answer.
    if (req.tools.some((t) => t.name === "knowledge_search")) {
      const result = await call("knowledge_search", { query: req.userText });
      const hits = safeJson(result)?.results ?? [];
      if (hits.length) return { text: bestParagraph(hits[0].snippet, req.userText), toolCalls, provider: this.name };
    }

    const he = /[֐-׿]/.test(req.userText);
    return {
      text: he
        ? "קיבלתי. (מצב הדגמה: חברו מפתח API של Claude לתשובות חכמות)"
        : "Got it. (Demo mode: connect a Claude API key for full AI answers.)",
      toolCalls,
      provider: this.name,
    };
  }

  /** The mock cannot generate free-form JSON; callers fall back to deterministic behaviour. */
  async json() {
    return null;
  }

  async classify(text: string, labels: { id: string; description: string }[]) {
    const words = new Set(tokenize(text));
    let best: { id: string; score: number } | null = null;
    for (const l of labels) {
      const keys = tokenize(`${l.id.replace(/[_-]/g, " ")} ${l.description}`);
      const score = keys.filter((k) => words.has(k) || [...words].some((w) => w.length > 3 && (w.startsWith(k) || k.startsWith(w)))).length;
      if (score > 0 && (!best || score > best.score)) best = { id: l.id, score };
    }
    return best?.id ?? null;
  }

  async extract(text: string, fields: { name: string; description: string }[]) {
    const out: Record<string, string | null> = {};
    for (const f of fields) out[f.name] = mockExtractValue(`${f.name} ${f.description}`, text);
    return out;
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function summarize(result: string): string {
  const j = safeJson(result);
  if (j?.message) return String(j.message);
  return result.length > 160 ? result.slice(0, 160) + "..." : result;
}

/** Pick the paragraph of a retrieved chunk that shares the most words with the question. */
function bestParagraph(snippet: string, question: string): string {
  const q = new Set(tokenize(question).map((w) => w.replace(/^[והבכלמש](?=\p{L}{3})/u, "")));
  const paras = snippet.split(/\n\s*\n/).filter((p) => p.trim());
  let best = paras[0] ?? snippet;
  let score = -1;
  for (const p of paras) {
    const s = tokenize(p).filter((w) => q.has(w) || q.has(w.replace(/^[והבכלמש](?=\p{L}{3})/u, ""))).length;
    if (s > score) {
      score = s;
      best = p;
    }
  }
  return best.trim();
}
