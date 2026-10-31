// LLM provider abstraction: Claude (Anthropic SDK) for real use, a deterministic mock for offline demo and tests.

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, any>; required?: string[] };
}

export interface AgentLoopRequest {
  model?: string;
  system: string;
  history: { role: "user" | "assistant"; text: string }[];
  userText: string;
  tools: ToolSpec[];
  executeTool: (name: string, input: Record<string, any>) => Promise<string>;
  maxSteps?: number;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, any>;
  result: string;
}

export interface AgentLoopResult {
  text: string;
  toolCalls: ToolCallRecord[];
  provider: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  name: string;
  runAgent(req: AgentLoopRequest): Promise<AgentLoopResult>;
  classify(text: string, labels: { id: string; description: string }[], model?: string): Promise<string | null>;
  /** Structured JSON generation against a JSON schema (used by the AI flow designer). */
  json(prompt: string, schema: Record<string, unknown>, opts?: { model?: string; system?: string; effort?: "low" | "medium" | "high" }): Promise<any>;
  /** Free-form text generation (automations: summaries, drafts, translations). */
  generate(prompt: string, opts?: { model?: string; system?: string; effort?: "low" | "medium" | "high" }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
  extract(text: string, fields: { name: string; description: string }[], model?: string): Promise<Record<string, string | null>>;
}
