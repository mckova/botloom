// Core domain types for BotLoom flows, runs and messages.

export type ChannelKind = "webchat" | "telegram" | "whatsapp" | "slack" | "discord" | "webhook" | "schedule" | "test";

/** A channel-agnostic outgoing message. Adapters downgrade what a channel cannot render. */
export interface OutMessage {
  text: string;
  buttons?: { id: string; label: string }[];
  imageUrl?: string;
}

/** A normalized inbound event. Every channel converts its payload into this shape. */
export interface InboundEvent {
  channel: ChannelKind;
  contactId: string; // stable id of the end user on that channel (chat id, phone number, ...)
  contactName?: string;
  text?: string;
  buttonId?: string; // set when the user pressed a button
  payload?: Record<string, unknown>; // raw webhook body / extra data
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
  sourcePort?: string; // default "out"
  target: string;
}

export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface AgentSettings {
  model?: string;
  systemPrompt?: string;
  language?: "he" | "en";
  /** Capabilities the AI agent node may call as tools. */
  allowedTools?: string[];
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  flow: Flow;
  settings: AgentSettings;
  createdAt: string;
  updatedAt: string;
}

export interface WaitState {
  nodeId: string;
  variable: string;
  since: string;
}

export interface Session {
  id: string;
  agentId: string;
  channel: ChannelKind;
  contactId: string;
  contactName?: string;
  vars: Record<string, any>;
  history: { role: "user" | "assistant"; text: string; at: string }[];
  wait: WaitState | null;
  handoff: boolean;
  updatedAt: string;
}

export interface TraceStep {
  nodeId: string;
  type: string;
  port?: string;
  startedAt: string;
  ms: number;
  input?: any;
  output?: any;
  error?: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  sessionId: string | null;
  trigger: string;
  status: "completed" | "waiting" | "failed" | "handoff";
  steps: TraceStep[];
  outbox: OutMessage[];
  startedAt: string;
  ms: number;
  error?: string;
}
