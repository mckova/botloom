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

  const result = await designLoop(llm, `Design a BotLoom agent for this request:\n\n<request>\n${prompt}\n</request>`, validate);
  return { ...result, designer: "claude" };
}

/** Draft -> validate -> repair loop shared by "design from scratch" and "revise with AI". */
async function designLoop(llm: LlmProvider, firstRequest: string, validate: Validate): Promise<Omit<DesignedAgent, "designer">> {
  const schema = structuredClone(SCHEMA);
  (schema.properties.nodes.items.properties.type as any).enum = listNodeDefs().map((d) => d.type);
  let request = firstRequest;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
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
      };
    }
    // Self-repair: give the model its own draft and the validator's findings.
    request = `${firstRequest}\n\nYour previous draft:\n${JSON.stringify(out)}\n\nThe validator found these problems. Return a corrected, complete design:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;
  }
  throw new Error(`The designer could not produce a valid flow: ${lastErrors.join("; ")}`);
}

/** The current agent in the designer's own output format, so Claude edits it instead of starting over. */
function asDraft(agent: { name: string; description: string; settings: { language?: string; systemPrompt?: string }; flow: Flow }) {
  return {
    name: agent.name,
    description: agent.description,
    language: agent.settings.language ?? "en",
    systemPrompt: agent.settings.systemPrompt ?? "",
    nodes: agent.flow.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label ?? "",
      configJson: JSON.stringify(n.config ?? {}),
      x: Math.round((n.position?.x ?? 0) / 260),
      y: Math.round((n.position?.y ?? 0) / 160),
    })),
    edges: agent.flow.edges.map((e) => ({ source: e.source, target: e.target, sourcePort: e.sourcePort ?? "out" })),
  };
}

/**
 * Flow copilot: "add a step that asks for the customer's city", "send me a Slack alert on every lead".
 * Claude edits the existing flow; the result is validated and repaired like a new design, and returned
 * as a proposal the user reviews before applying.
 */
export async function reviseAgent(
  llm: LlmProvider,
  agent: { name: string; description: string; settings: { language?: string; systemPrompt?: string }; flow: Flow },
  instruction: string,
  validate: Validate,
): Promise<Omit<DesignedAgent, "designer">> {
  if (llm.name === "mock") return reviseByRules(agent, instruction);
  const request = `Revise this existing BotLoom agent according to the owner's instruction.

Rules for a revision:
- Keep every node id, label, config value and edge the instruction does not ask to change.
- New nodes get new short camelCase ids; place them near the nodes they connect to.
- "knowledge" must contain only NEW documents worth adding (usually an empty array).
- "notes" must list, in the owner's language, each change you made, one per item, plus any setup the owner must do.

<current_agent>
${JSON.stringify(asDraft(agent))}
</current_agent>

<instruction>
${instruction}
</instruction>`;
  return designLoop(llm, request, validate);
}

/**
 * Demo-mode editor: understands one common request, "alert me on Slack/Telegram/Discord/WhatsApp when ...",
 * so the command bar works without an API key. Anything else asks for a Claude key.
 */
export function reviseByRules(
  agent: { name: string; description: string; settings: { language?: string; systemPrompt?: string }; flow: Flow },
  instruction: string,
): Omit<DesignedAgent, "designer"> {
  const channel = instruction.match(/\b(slack|telegram|discord|whatsapp)\b/i)?.[1]?.toLowerCase();
  const wantsAlert = /\b(alert|notify|ping|message|tell|send)\b/i.test(instruction);
  if (!channel || !wantsAlert) {
    throw new Error(
      "The demo editor understands requests like \"alert me on Slack when someone asks for a human\". Set ANTHROPIC_API_KEY on the server to describe any other change.",
    );
  }
  const flow: Flow = JSON.parse(JSON.stringify(agent.flow));
  const forHandoff = /lead|human|handoff|hand off|escalat|person|team|נציג/i.test(instruction);
  const agentNode = flow.nodes.find((n) => n.type === "ai.agent");
  const id = (() => {
    let n = 1;
    while (flow.nodes.some((x) => x.id === `notify${n === 1 ? "" : n}`)) n++;
    return `notify${n === 1 ? "" : n}`;
  })();
  let from: { id: string; port?: string } | undefined;
  if (forHandoff && agentNode) from = { id: agentNode.id, port: "handoff" };
  else {
    // Attach after the end of the first trigger's chain.
    const trigger = flow.nodes.find((n) => n.type.startsWith("trigger."));
    let cur = trigger?.id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const next = flow.edges.find((e) => e.source === cur && (e.sourcePort ?? "out") === "out");
      if (!next) break;
      cur = next.target;
    }
    if (cur) from = { id: cur };
  }
  if (!from) throw new Error("This flow has no starting step to attach the alert to.");
  const anchor = flow.nodes.find((n) => n.id === from!.id);
  const where = forHandoff ? "when the agent hands a conversation to your team" : "when the flow finishes";
  flow.nodes.push({
    id,
    type: "channel.notify",
    label: `Alert on ${channel}`,
    position: { x: (anchor?.position?.x ?? 0) + 300, y: (anchor?.position?.y ?? 0) + 140 },
    config: { channel, to: "", text: "{{contact.name}} on {{contact.channel}}: {{vars.handoff_reason}}" },
  });
  flow.edges.push({ id: `e_${from.id}_${id}`, source: from.id, ...(from.port ? { sourcePort: from.port } : {}), target: id });
  return {
    name: agent.name,
    description: agent.description,
    language: (agent.settings.language as "he" | "en") ?? "en",
    systemPrompt: agent.settings.systemPrompt ?? "",
    flow,
    docs: [],
    notes: [
      `Added an "Alert on ${channel}" step ${where}.`,
      channel === "slack" || channel === "discord" ? `Paste your ${channel} incoming-webhook URL in the Channels tab, or in the step's recipient field.` : `Set the chat or phone number to alert in the new step.`,
    ],
  };
}
