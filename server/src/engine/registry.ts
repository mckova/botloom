// Node registry. Each node type declares its config schema (the builder renders forms from it),
// its output ports, and how it runs. Adding a node type requires no UI code.
import type { Agent, FlowNode, InboundEvent, OutMessage, Session } from "./types.js";
import type { LlmProvider } from "../llm/provider.js";
import type { GoogleClient } from "../integrations/google.js";
import type { Store } from "../db.js";

export type FieldKind = "text" | "textarea" | "select" | "number" | "boolean" | "lines" | "keyvalue" | "multiselect";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  default?: any;
  /** Conditional display: show only when another field has one of these values. */
  showIf?: { key: string; in: any[] };
}

export interface Services {
  store: Store;
  llm: LlmProvider;
  google: GoogleClient;
  http: typeof fetch;
  /** Send a message to any contact on any connected channel of this agent (used by notify nodes). */
  notify: (agentId: string, channel: string, to: string, msg: OutMessage) => Promise<{ delivered: boolean; detail?: string }>;
}

export interface RunContext {
  agent: Agent;
  session: Session;
  event: InboundEvent;
  services: Services;
  outputs: Record<string, any>;
  send: (msg: OutMessage) => void;
  scope: () => Record<string, any>;
}

export interface NodeResult {
  port?: string;
  output?: any;
  /** Suspend the run until this contact sends the next message. */
  wait?: boolean;
  handoff?: boolean;
  end?: boolean;
}

export interface NodeDef {
  type: string;
  category: "trigger" | "message" | "logic" | "ai" | "integration";
  label: string;
  description: string;
  icon: string;
  trigger?: boolean;
  fields: FieldDef[];
  ports: (config: Record<string, any>) => string[];
  run: (ctx: RunContext, node: FlowNode) => Promise<NodeResult>;
  /** Called when a suspended run receives the contact's next message. */
  resume?: (ctx: RunContext, node: FlowNode, event: InboundEvent) => Promise<NodeResult>;
}

const registry = new Map<string, NodeDef>();

export function defineNode(def: NodeDef) {
  registry.set(def.type, def);
}
export function getNodeDef(type: string): NodeDef | undefined {
  return registry.get(type);
}
export function listNodeDefs(): NodeDef[] {
  return [...registry.values()];
}

/** Parse "id: description" lines (used by intent and extract nodes). */
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
