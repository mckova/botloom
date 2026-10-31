import { buildApp } from "./app.js";
import { startScheduler } from "./scheduler.js";
import { TelegramPoller, parseTelegram } from "./channels/hub.js";

const port = Number(process.env.PORT ?? 8787);
const { app, store, engine, hub, services } = await buildApp();

startScheduler(store, engine, hub);

// Local development without a public URL: BOTLOOM_TELEGRAM_POLLING=1 long-polls every connected bot.
if (process.env.BOTLOOM_TELEGRAM_POLLING === "1") {
  for (const ch of store.listChannels().filter((c) => c.kind === "telegram" && c.enabled && c.config.botToken)) {
    const poller = new TelegramPoller(ch.config.botToken, async (update) => {
      const agent = store.getAgent(ch.agentId);
      const event = parseTelegram(update);
      if (!agent || !event) return;
      const outcome = await engine.handle(agent, event);
      await hub.deliver(agent.id, "telegram", event.contactId, outcome.outbox);
    });
    poller.start();
    app.log.info(`Telegram polling started for agent ${ch.agentId}`);
  }
}

await app.listen({ port, host: "0.0.0.0" });
app.log.info(`BotLoom running on http://localhost:${port} (LLM: ${services.llm.name}, Google: ${services.google.live ? "live" : "sandbox"})`);
