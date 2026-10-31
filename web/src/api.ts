export interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "textarea" | "select" | "number" | "boolean" | "lines" | "keyvalue" | "multiselect";
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  default?: any;
  showIf?: { key: string; in: any[] };
}
export interface NodeType {
  type: string;
  category: "trigger" | "message" | "logic" | "ai" | "integration";
  label: string;
  description: string;
  icon: string;
  trigger: boolean;
  fields: FieldDef[];
  ports: string[];
}
export interface FlowNode {
  id: string;
  type: string;
  label?: string;
  position?: { x: number; y: number };
  config: Record<string, any>;
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
}
export interface Agent {
  id: string;
  name: string;
  description: string;
  flow: { nodes: FlowNode[]; edges: FlowEdge[] };
  settings: { model?: string; systemPrompt?: string; language?: "he" | "en"; allowedTools?: string[] };
  stats?: { runs: number; failed: number; handoffs: number; avgMs: number; contacts: number };
  validation?: { errors: string[]; warnings: string[] };
  updatedAt: string;
}
export interface OutMessage {
  text: string;
  buttons?: { id: string; label: string }[];
  imageUrl?: string;
}
export interface TraceStep {
  nodeId: string;
  type: string;
  port?: string;
  ms: number;
  input?: any;
  output?: any;
  error?: string;
}
export interface Run {
  id: string;
  trigger: string;
  status: string;
  steps: TraceStep[];
  outbox: OutMessage[];
  startedAt: string;
  ms: number;
  error?: string;
  sessionId: string | null;
}
export interface Session {
  id: string;
  channel: string;
  contactId: string;
  contactName?: string;
  vars: Record<string, any>;
  history: { role: string; text: string; at: string }[];
  wait: { nodeId: string } | null;
  handoff: boolean;
  updatedAt: string;
}

const token = () => localStorage.getItem("botloom_token") ?? "";

export async function api<T = any>(path: string, init: RequestInit & { json?: any } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  if (res.status === 401) {
    const t = prompt("Admin token");
    if (t) {
      localStorage.setItem("botloom_token", t);
      return api(path, init);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error ?? res.status));
  return data as T;
}

/** Same rule as the server's parseLines: "id: label" per line. */
export function parseLines(v: unknown): { id: string; description: string }[] {
  const lines = Array.isArray(v) ? v.map(String) : String(v ?? "").split("\n");
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      return i > 0 ? { id: l.slice(0, i).trim(), description: l.slice(i + 1).trim() } : { id: l, description: l };
    });
}

export function portsFor(node: FlowNode, def?: NodeType): string[] {
  if (node.type === "message.ask" && node.config.validate === "choice") return [...parseLines(node.config.choices).map((c) => c.id), "invalid"];
  if (node.type === "ai.intent") return [...parseLines(node.config.intents).map((c) => c.id), "fallback"];
  if (node.type === "google.calendar.create" && node.config.checkBusy === false) return ["out", "error"];
  return def?.ports ?? ["out"];
}

/** Evaluate a field's showIf against the node config (array values match if any element is listed). */
export function isVisible(f: FieldDef, config: Record<string, any>, fields: FieldDef[]): boolean {
  if (!f.showIf) return true;
  const dep = fields.find((x) => x.key === f.showIf!.key);
  const v = config[f.showIf.key] ?? dep?.default;
  const allowed = f.showIf.in.map((x) => (x === null ? undefined : x));
  return Array.isArray(v) ? v.some((x) => allowed.includes(x)) : allowed.includes(v);
}
