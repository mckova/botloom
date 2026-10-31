// AI flow designer: the user describes a bot in plain language (Hebrew or English) and Claude
// designs the whole agent: flow graph, persona, and starter knowledge. The draft is validated by the
// same rules as a hand-built flow; on errors Claude gets the errors back and repairs its own draft.
import { listNodeDefs, getNodeDef } from "../engine/registry.js";
import { AGENT_TOOLS } from "../engine/nodes/ai.js";
import type { Flow } from "../engine/types.js";
import type { LlmProvider } from "../llm/provider.js";
import { TEMPLATES } from "../templates.js";

export interface DesignedAgent {
  name: string;
  description: string;
  language: "he" | "en";
  systemPrompt: string;
  flow: Flow;
  docs: { title: string; content: string }[];
  notes: string[];
  designer: "claude" | "template-match";
}

type Validate = (flow: Flow) => { errors: string[]; warnings: string[] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "language", "systemPrompt", "nodes", "edges", "knowledge", "notes"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    language: { type: "string", enum: ["he", "en"] },
    systemPrompt: { type: "string", description: "Persona shared by every AI node" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "label", "configJson", "x", "y"],
        properties: {
          id: { type: "string", description: "short camelCase id" },
          type: { type: "string", enum: [] as string[] },
          label: { type: "string" },
          configJson: { type: "string", description: "JSON object with the node's config fields" },
          x: { type: "integer", description: "column, 0 = trigger" },
          y: { type: "integer", description: "row" },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "sourcePort"],
        properties: { source: { type: "string" }, target: { type: "string" }, sourcePort: { type: "string" } },
      },
    },
    knowledge: {
      type: "array",
      description: "Starter knowledge-base documents with placeholder business facts the owner should edit",
      items: { type: "object", additionalProperties: false, required: ["title", "content"], properties: { title: { type: "string" }, content: { type: "string" } } },
    },
    notes: { type: "array", items: { type: "string" }, description: "Setup steps for the owner (ids to fill in, channels to connect)" },
  },
};

function catalogue(): string {
  return listNodeDefs()
    .map((d) => {
      const fields = d.fields
        .map((f) => `    - ${f.key} (${f.kind}${f.options ? `: ${f.options.map((o) => o.value).join("|")}` : ""})${f.help ? ` - ${f.help}` : ""}`)
        .join("\n");
      const ports =
        d.type === "message.ask" ? "out, invalid; when validate=choice the ports are the choice ids + invalid" : d.type === "ai.intent" ? "one port per intent id + fallback" : d.ports({}).join(", ") || "(none, ends the run)";
      return `- ${d.type}: ${d.description}\n  ports: ${ports}\n  config:\n${fields}`;
    })
    .join("\n");
}

const SYSTEM = `You are BotLoom's flow designer. You turn a business owner's description into a working chatbot / automation flow for the BotLoom runtime.

Runtime rules:
- A flow is a graph of nodes joined by edges from a named output port to a target node.
- Conversations start at trigger.message. message.ask sends a question and pauses until the contact replies; the answer is saved in vars.<variable>.
- ai.agent is a Claude agent that answers the contact using the tools you enable (${Object.keys(AGENT_TOOLS).join(", ")}). With loop=true it keeps the conversation; its "handoff" port fires when it hands off to a human.
- Automations start at trigger.webhook (external systems POST data, available as {{message.payload.*}}) or trigger.schedule.
- Templates: {{vars.x}}, {{message.text}}, {{contact.name}}, {{contact.channel}}, {{message.payload.x}}, {{now.iso}}, {{now.date}}. Filters: | upper, | default: 'x'.
- "lines" fields are newline-separated strings; choice lines look like "book: Book an appointment". keyvalue fields are objects. multiselect fields are arrays.
- Use OWNER_CHAT_ID / demo-sheet / primary as placeholders for ids the owner must fill in, and list them in notes.

Design guidelines:
- Prefer AI-native designs: use ai.agent with tools for open questions, ai.intent to route free text, ai.extract to pull details from free text. Use deterministic ask/condition nodes where the business needs exact data (bookings, phone numbers).
- Always handle the invalid / fallback / error ports that matter, and offer a human handoff.
- Write user-facing text in the language the owner wrote in.
- Lay nodes out left to right: x = step column, y = branch row. Keep it compact (at most 6 columns).

Node catalogue:
${catalogue()}`;

export function matchTemplate(prompt: string) {
  const p = prompt.toLowerCase();
  const score = (words: string[]) => words.filter((w) => p.includes(w)).length;
  const ranked = [
    { t: "clinic-receptionist", s: score(["תור", "תורים", "מרפאה", "קליניקה", "appointment", "booking", "book", "clinic", "salon", "מספרה", "קביעת"]) },
    { t: "order-automation", s: score(["webhook", "וובהוק", "הזמנה", "הזמנות", "order", "orders", "automation", "אוטומציה", "schedule", "daily", "יומי"]) },
    { t: "ai-sales-agent", s: score(["sales", "support", "מכירות", "תמיכה", "lead", "לידים", "faq", "שאלות", "store", "חנות"]) },
  ].sort((a, b) => b.s - a.s);
  return TEMPLATES.find((t) => t.id === ranked[0].t)!;
}

export async function designAgent(llm: LlmProvider, prompt: string, validate: Validate): Promise<DesignedAgent> {
  if (llm.name === "mock") {
    const t = matchTemplate(prompt);
    return {
      name: t.name,
      description: t.description,
      language: t.language,
      systemPrompt: t.systemPrompt ?? "",
      flow: structuredClone(t.flow),
      docs: t.docs ?? [],
      notes: ["Demo mode: without an Anthropic API key the designer picks the closest template. Set ANTHROPIC_API_KEY for a custom design."],
      designer: "template-match",
    };
  }

  const schema = structuredClone(SCHEMA);
  (schema.properties.nodes.items.properties.type as any).enum = listNodeDefs().map((d) => d.type);
  let request = `Design a BotLoom agent for this request:\n\n<request>\n${prompt}\n</request>`;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.json(request, schema, { system: SYSTEM, effort: "medium" });
    if (!out) throw new Error("The designer returned no result");
    const parseErrors: string[] = [];
    const flow: Flow = {
      nodes: out.nodes.map((n: any) => {
        let config: Record<string, any> = {};
        try {
          config = JSON.parse(n.configJson || "{}");
        } catch {
          parseErrors.push(`Node ${n.id}: configJson is not valid JSON`);
        }
        // Fill defaults for fields the model left out.
        for (const f of getNodeDef(n.type)?.fields ?? []) if (config[f.key] === undefined && f.default !== undefined) config[f.key] = f.default;
        return { id: n.id, type: n.type, label: n.label, config, position: { x: n.x * 260, y: n.y * 160 } };
      }),
      edges: out.edges.map((e: any, i: number) => ({ id: `e${i + 1}`, source: e.source, target: e.target, sourcePort: e.sourcePort || "out" })),
    };
    const v = validate(flow);
    lastErrors = [...parseErrors, ...v.errors, ...v.warnings.filter((w) => /unknown port|no trigger/.test(w))];
    if (!lastErrors.length) {
      return {
        name: out.name,
        description: out.description,
        language: out.language,
        systemPrompt: out.systemPrompt,
        flow,
        docs: out.knowledge ?? [],
        notes: [...(out.notes ?? []), ...v.warnings],
        designer: "claude",
      };
    }
    // Self-repair: give the model its own draft and the validator's findings.
    request = `${request}\n\nYour previous draft:\n${JSON.stringify(out)}\n\nThe validator found these problems. Return a corrected, complete design:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;
  }
  throw new Error(`The designer could not produce a valid flow: ${lastErrors.join("; ")}`);
}
