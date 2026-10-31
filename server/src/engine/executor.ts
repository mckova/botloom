// The BotLoom runtime: one resumable engine for conversations (pause on Ask, resume on reply)
// and automations (webhook / schedule triggers).
import "./nodes/core.js";
import "./nodes/ai.js";
import "./nodes/integrations.js";
import { getNodeDef, type NodeResult, type RunContext, type Services } from "./registry.js";
import type { Agent, FlowNode, InboundEvent, OutMessage, RunRecord, Session, TraceStep } from "./types.js";
import { newId, now } from "../db.js";

const MAX_STEPS = 60;
const RESET = /^\/(restart|start|reset)$|^(התחל מחדש|מההתחלה)$/i;

export interface RunOutcome {
  run: RunRecord;
  session: Session;
  outbox: OutMessage[];
}

export interface StartOptions {
  /** Start from this trigger node (webhook / schedule). Otherwise a message trigger is chosen. */
  triggerNodeId?: string;
  triggerLabel?: string;
}

function pickMessageTrigger(agent: Agent, event: InboundEvent): FlowNode | undefined {
  const triggers = agent.flow.nodes.filter((n) => n.type === "trigger.message");
  const onChannel = triggers.filter((t) => !t.config.channels?.length || t.config.channels.includes(event.channel));
  const text = (event.text ?? "").toLowerCase();
  const keyworded = onChannel.find((t) =>
    String(t.config.keywords ?? "")
      .split(",")
      .map((k: string) => k.trim().toLowerCase())
      .filter(Boolean)
      .some((k: string) => text.includes(k)),
  );
  return keyworded ?? onChannel.find((t) => !String(t.config.keywords ?? "").trim());
}

export class Engine {
  constructor(private services: Services) {}

  private context(agent: Agent, session: Session, event: InboundEvent, outbox: OutMessage[], outputs: Record<string, any>): RunContext {
    return {
      agent,
      session,
      event,
      services: this.services,
      outputs,
      send: (msg) => {
        outbox.push(msg);
        if (msg.text) session.history.push({ role: "assistant", text: msg.text, at: now() });
      },
      scope: () => ({
        vars: session.vars,
        message: { text: event.text ?? "", buttonId: event.buttonId, channel: event.channel, payload: event.payload ?? {} },
        contact: { id: session.contactId, name: session.contactName ?? "", channel: session.channel },
        agent: { id: agent.id, name: agent.name },
        nodes: outputs,
        now: { iso: new Date().toISOString(), date: new Date().toISOString().slice(0, 10) },
      }),
    };
  }

  async handle(agent: Agent, event: InboundEvent, opts: StartOptions = {}): Promise<RunOutcome> {
    const store = this.services.store;
    const started = Date.now();
    const session = store.getOrCreateSession(agent.id, event.channel, event.contactId, event.contactName);
    if (event.contactName) session.contactName = event.contactName;
    const outbox: OutMessage[] = [];
    const outputs: Record<string, any> = {};
    const steps: TraceStep[] = [];
    const run: RunRecord = {
      id: newId("run"),
      agentId: agent.id,
      sessionId: session.id,
      trigger: opts.triggerLabel ?? `message:${event.channel}`,
      status: "completed",
      steps,
      outbox,
      startedAt: now(),
      ms: 0,
    };
    const finish = (): RunOutcome => {
      run.ms = Date.now() - started;
      store.saveSession(session);
      store.saveRun(run);
      return { run, session, outbox };
    };

    if (event.text) session.history.push({ role: "user", text: event.text, at: now() });

    if (!event.text && !event.buttonId && !opts.triggerNodeId && session.wait) {
      // Empty "hello" ping (e.g. the widget opening) while a question is pending: nothing to do.
      run.status = "waiting";
      return finish();
    }

    if (event.text && RESET.test(event.text.trim())) {
      session.wait = null;
      session.handoff = false;
      session.vars = {};
    } else if (session.handoff && !opts.triggerNodeId) {
      // A human owns this conversation; the bot stays silent and just records the message.
      run.status = "handoff";
      return finish();
    }

    const ctx = this.context(agent, session, event, outbox, outputs);
    const byId = new Map(agent.flow.nodes.map((n) => [n.id, n]));
    const queue: { node: FlowNode; resume: boolean }[] = [];

    if (session.wait && !opts.triggerNodeId && byId.has(session.wait.nodeId)) {
      queue.push({ node: byId.get(session.wait.nodeId)!, resume: true });
    } else {
      const start = opts.triggerNodeId ? byId.get(opts.triggerNodeId) : pickMessageTrigger(agent, event);
      if (!start) {
        run.status = "failed";
        run.error = "No matching trigger in flow";
        return finish();
      }
      session.wait = null;
      queue.push({ node: start, resume: false });
    }

    try {
      let count = 0;
      while (queue.length) {
        if (++count > MAX_STEPS) throw new Error(`Step limit (${MAX_STEPS}) reached; check the flow for loops`);
        const { node, resume } = queue.shift()!;
        const def = getNodeDef(node.type);
        if (!def) throw new Error(`Unknown node type ${node.type}`);
        const t0 = Date.now();
        const step: TraceStep = { nodeId: node.id, type: node.type, startedAt: now(), ms: 0, input: resume ? { reply: event.text, buttonId: event.buttonId } : undefined };
        let result: NodeResult;
        try {
          result = resume && def.resume ? await def.resume(ctx, node, event) : await def.run(ctx, node);
        } catch (err: any) {
          step.error = String(err?.message ?? err);
          step.ms = Date.now() - t0;
          steps.push(step);
          throw err;
        }
        step.ms = Date.now() - t0;
        step.port = result.port;
        step.output = result.output;
        steps.push(step);
        outputs[node.id] = result.output ?? null;

        if (result.handoff) {
          session.handoff = true;
          session.wait = null;
          run.status = "handoff";
        }
        if (result.wait) {
          session.wait = { nodeId: node.id, variable: node.config.variable ?? "", since: now() };
          run.status = "waiting";
          queue.length = 0; // a waiting node suspends the whole run
          break;
        }
        if (result.end) continue;
        if (session.wait?.nodeId === node.id) session.wait = null;
        const port = result.port ?? "out";
        for (const e of agent.flow.edges) {
          if (e.source === node.id && (e.sourcePort ?? "out") === port) {
            const target = byId.get(e.target);
            if (target) queue.push({ node: target, resume: false });
          }
        }
      }
      if (run.status === "completed" && session.wait) session.wait = null;
      if (session.handoff && run.status !== "failed") run.status = "handoff"; // e.g. set by an agent tool
    } catch (err: any) {
      run.status = "failed";
      run.error = String(err?.message ?? err);
      session.wait = null;
      const he = agent.settings.language === "he";
      outbox.push({ text: he ? "אופס, משהו השתבש. נסו שוב בעוד רגע." : "Oops, something went wrong. Please try again in a moment." });
    }
    return finish();
  }
}
