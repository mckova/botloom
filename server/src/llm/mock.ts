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
  if (f.includes("order") || f.includes("number") || f.includes("id")) return text.match(/\b([A-Z]{0,3}-?\d{3,})\b/i)?.[1] ?? null;
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

    // 2. Long-term memory: explicit preferences are saved, then the conversation continues.
    const memory = req.tools.find((t) => t.name === "remember");
    const pref = req.userText.match(/(?:remember that|i prefer|i always|תזכרי? ש|אני מעדיפה?|אני תמיד)\s*(.+)/iu);
    if (memory && pref) {
      await call("remember", { fact: pref[0].replace(/^(?:remember that|תזכרי? ש)\s*/iu, "").trim() });
      const he = /[\u0590-\u05FF]/.test(req.userText);
      return { text: he ? "רשמתי לעצמי, אזכור את זה בפעם הבאה." : "Noted, I'll remember that next time.", toolCalls, provider: this.name };
    }

    // 3. Availability questions.
    const avail = req.tools.find((t) => t.name === "check_availability");
    const date = mockExtractValue("date", req.userText);
    if (avail && /availab|free slot|open slot|when can|פנוי|פנויים|זמינ|מתי אפשר/i.test(req.userText)) {
      const day = (date ?? new Date().toLocaleDateString("en-CA")).slice(0, 10);
      const result = safeJson(await call("check_availability", { from_date: day }));
      const slots: string[] = result?.slots ?? [];
      return {
        text: slots.length ? `Free on ${day}: ${slots.slice(0, 3).map((s) => s.slice(11)).join(", ")}. Which one suits you?` : `No free slots on ${day}.`,
        toolCalls,
        provider: this.name,
      };
    }

    // 4. Any other tool whose keywords appear in the message gets called with extracted args.
    for (const tool of req.tools) {
      if (["knowledge_search", "handoff_to_human", "remember", "check_availability"].includes(tool.name)) continue;
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
      return { text: summarize(result), toolCalls, provider: this.name };
    }

    // 5. Knowledge base answer.
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

  /** Deterministic stand-in: echoes the first lines of the prompt so automations stay testable offline. */
  async generate(prompt: string) {
    const body = prompt.replace(/\s+/g, " ").trim();
    return { text: `[demo] ${body.length > 240 ? body.slice(0, 240) + "..." : body}` };
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
  if (j && typeof j === "object" && !Array.isArray(j)) {
    // Turn a flat tool result into a readable line, e.g. "Order 1042: status shipped, eta 3-5 business days."
    const parts = Object.entries(j)
      .filter(([k, v]) => !["ok", "sandbox"].includes(k) && v !== null && typeof v !== "object")
      .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`);
    if (parts.length) return parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".";
  }
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
