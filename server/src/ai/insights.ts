// AI assistance for the human team: a handoff brief when a conversation reaches the inbox, and a
// suggested reply the team member can edit before sending.
import type { LlmProvider } from "../llm/provider.js";
import type { Session } from "../engine/types.js";

export interface HandoffBrief {
  summary: string;
  customerWants: string;
  sentiment: "positive" | "neutral" | "negative" | "upset";
  urgency: "low" | "medium" | "high";
  nextStep: string;
  by: "claude" | "rules";
  at: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "customerWants", "sentiment", "urgency", "nextStep"],
  properties: {
    summary: { type: "string", description: "Two sentences: what happened so far" },
    customerWants: { type: "string", description: "What the customer needs, in one line" },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative", "upset"] },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    nextStep: { type: "string", description: "The single best next action for the team member" },
  },
};

const transcript = (s: Session) =>
  s.history
    .slice(-20)
    .map((h) => `${h.role === "user" ? "Customer" : "Bot"}: ${h.text}`)
    .join("\n");

export async function handoffBrief(llm: LlmProvider, session: Session, model?: string): Promise<HandoffBrief> {
  const at = new Date().toISOString();
  if (llm.name !== "mock") {
    try {
      const out = await llm.json(
        `A chatbot conversation was handed to a human team member. Brief them so they can take over without reading everything. Write in the language the customer used.\n\nKnown details: ${JSON.stringify(
          Object.fromEntries(Object.entries(session.vars).filter(([k]) => !k.startsWith("__"))),
        )}\n\n<transcript>\n${transcript(session)}\n</transcript>`,
        SCHEMA,
        { model, effort: "low" },
      );
      if (out?.summary) return { ...out, by: "claude", at };
    } catch {
      // fall through to the rule-based brief: a failed brief must never block the handoff
    }
  }
  const userLines = session.history.filter((h) => h.role === "user").map((h) => h.text);
  const all = userLines.join(" ");
  const upset = /angry|terrible|worst|refund|complain|כועס|גרוע|נורא|החזר|תלונה|!!/i.test(all);
  const urgent = /urgent|asap|now|today|דחוף|מיד|עכשיו|היום/i.test(all);
  return {
    summary: userLines.slice(-3).join(" / ") || "No messages yet.",
    customerWants: String(session.vars.handoff_reason ?? userLines.at(-1) ?? ""),
    sentiment: upset ? "upset" : "neutral",
    urgency: urgent || upset ? "high" : "medium",
    nextStep: "Reply to the customer and hand the conversation back to the bot when done.",
    by: "rules",
    at,
  };
}
