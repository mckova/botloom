// Fires trigger.schedule nodes. Interval mode: every N minutes. Daily mode: once a day at HH:MM.
import type { Store } from "./db.js";
import type { Engine } from "./engine/executor.js";
import type { ChannelHub } from "./channels/hub.js";

export function dueTriggers(store: Store, lastRun: Map<string, number>, at: Date) {
  const due: { agentId: string; nodeId: string }[] = [];
  for (const agent of store.listAgents()) {
    for (const n of agent.flow.nodes) {
      if (n.type !== "trigger.schedule") continue;
      const key = `${agent.id}:${n.id}`;
      const prev = lastRun.get(key);
      if (n.config.mode === "daily") {
        const [h, m] = String(n.config.time ?? "09:00").split(":").map(Number);
        const today = new Date(at);
        today.setHours(h, m, 0, 0);
        if (at >= today && (!prev || prev < today.getTime())) due.push({ agentId: agent.id, nodeId: n.id });
      } else {
        const every = Math.max(1, Number(n.config.minutes ?? 60)) * 60_000;
        if (prev === undefined) lastRun.set(key, at.getTime()); // first tick only arms the timer
        else if (at.getTime() - prev >= every) due.push({ agentId: agent.id, nodeId: n.id });
      }
    }
  }
  return due;
}

export function startScheduler(store: Store, engine: Engine, hub: ChannelHub, tickMs = 30_000) {
  const lastRun = new Map<string, number>();
  // Daily triggers whose time already passed today should not fire at boot.
  const boot = new Date();
  for (const d of dueTriggers(store, lastRun, boot)) lastRun.set(`${d.agentId}:${d.nodeId}`, boot.getTime());
  const timer = setInterval(async () => {
    const at = new Date();
    for (const d of dueTriggers(store, lastRun, at)) {
      lastRun.set(`${d.agentId}:${d.nodeId}`, at.getTime());
      const agent = store.getAgent(d.agentId);
      if (!agent) continue;
      const outcome = await engine.handle(agent, { channel: "schedule", contactId: `schedule:${d.nodeId}` }, { triggerNodeId: d.nodeId, triggerLabel: "schedule" });
      await hub.deliver(agent.id, "schedule", "", outcome.outbox);
    }
  }, tickMs);
  return () => clearInterval(timer);
}
