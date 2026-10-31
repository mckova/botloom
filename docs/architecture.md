# Architecture

## Layout
```
server/src/
  app.ts                 REST API, channel webhooks, widget endpoints, flow validation (graph analysis)
  index.ts               boot: HTTP server, scheduler, optional Telegram long polling
  db.ts                  SQLite store (node:sqlite): agents, sessions, runs, channels, kb_docs, integration_log
  engine/
    types.ts             Flow, nodes, edges, sessions, run records, channel-agnostic messages
    registry.ts          node type registry: schema-driven fields (with showIf), ports, run/resume
    executor.ts          the resumable runtime
    template.ts          safe {{path | filter}} templating (no eval)
    nodes/core.ts        triggers, send/ask/handoff/end, condition/set/delay
    nodes/ai.ts          AI agent (tools + flow tools), intent router, extract, knowledge search
    nodes/integrations.ts HTTP (SSRF guard), Sheets, Calendar, Gmail, cross-channel notify
  ai/designer.ts         natural-language → flow designer with validate-and-repair loop
  llm/                   provider interface, Claude provider, deterministic mock
  channels/hub.ts        Telegram / WhatsApp adapters, button downgrade, delivery, long polling
  integrations/google.ts Google auth (service account JWT or refresh token) + sandbox mode
  knowledge/bm25.ts      chunking + BM25 retrieval (Hebrew-aware)
  scheduler.ts           interval / daily triggers
  templates.ts           three ready-made agents
server/public/widget.js  embeddable chat widget
web/src/                 React dashboard (builder, simulator, conversations, runs, knowledge, channels, settings)
```

## Run lifecycle
1. A channel adapter converts the platform payload into an `InboundEvent` (`channel`, `contactId`, `text`, `buttonId`, `payload`).
2. The engine loads or creates the **session** for (agent, channel, contact).
3. If the session is **waiting** on a node, that node's `resume()` gets the reply; otherwise a trigger is chosen
   (keyword-specific message trigger first, then catch-all; or the webhook/schedule trigger that fired).
4. Nodes run breadth-first along edges from the port each node returns. A node may:
   `send()` messages to the outbox, set variables, return `wait` (suspend: the session stores the node id),
   `handoff` (the bot goes silent for this contact) or `end`.
5. Every step is appended to the **trace** (input, output, port, ms, error). The run, session and outbox are saved;
   the hub delivers the outbox to the channel.

Guards: a 60-step limit per run, `/restart` resets a conversation, and errors produce a friendly message plus a failed run.

## AI
- **Claude provider** (`llm/anthropic.ts`): manual tool-use loop (tools are assembled per agent at runtime and every call is
  traced); adaptive thinking; `effort: low` for chat latency; server-side refusal fallbacks
  (`fallbacks: "default"`); full assistant content appended to history; all tool results returned in one user turn.
- **Structured outputs** (`output_config.format`) power the intent router, extraction and the designer.
- **Designer**: the node catalogue (types, fields, ports) is rendered from the registry into the system prompt, so new
  node types are automatically available to it. Output is validated by `validateFlow`, and errors go back to Claude once
  for self-repair.
- **Flow tools**: `{{ai.field}}` placeholders in a node's config define a tool schema; when Claude calls the tool,
  the node runs with `ai.*` bound to the arguments.

## Security
- Builder API behind `BOTLOOM_ADMIN_TOKEN`; tokens masked in API responses.
- Telegram webhooks require the per-bot secret header; WhatsApp POSTs are HMAC-verified with the app secret.
- Templates cannot execute code or touch prototypes; the HTTP node blocks private/metadata addresses by default.
- AI tools are allow-listed per node and per agent; a disallowed call raises inside the loop and is shown in the trace.
