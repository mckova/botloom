// Channel adapters. Each adapter normalizes inbound payloads into InboundEvent and renders
// OutMessage for its platform, downgrading what the platform cannot show (e.g. >3 WhatsApp buttons).
import type { ChannelConfig, Store } from "../db.js";
import type { InboundEvent, OutMessage } from "../engine/types.js";

type Fetch = typeof fetch;

export interface DeliveryResult {
  delivered: boolean;
  detail?: string;
}

/** Buttons rendered as a numbered list; the Ask node accepts the number as the answer. */
export function buttonsAsText(msg: OutMessage): string {
  if (!msg.buttons?.length) return msg.text;
  return `${msg.text}\n\n${msg.buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n")}`;
}

// ---------------- Telegram ----------------
export function parseTelegram(update: any): InboundEvent | null {
  if (update?.callback_query) {
    const q = update.callback_query;
    return {
      channel: "telegram",
      contactId: String(q.message?.chat?.id ?? q.from.id),
      contactName: [q.from.first_name, q.from.last_name].filter(Boolean).join(" "),
      text: q.data,
      buttonId: q.data,
      payload: { callbackQueryId: q.id },
    };
  }
  const m = update?.message ?? update?.edited_message;
  if (!m?.chat) return null;
  return {
    channel: "telegram",
    contactId: String(m.chat.id),
    contactName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "),
    text: m.text ?? m.caption ?? "",
  };
}

export async function sendTelegram(http: Fetch, token: string, chatId: string, msg: OutMessage): Promise<DeliveryResult> {
  const base = `https://api.telegram.org/bot${token}`;
  const reply_markup = msg.buttons?.length
    ? { inline_keyboard: msg.buttons.map((b) => [{ text: b.label, callback_data: b.id.slice(0, 64) }]) }
    : undefined;
  const res = msg.imageUrl
    ? await http(`${base}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: msg.imageUrl, caption: msg.text, reply_markup }),
      })
    : await http(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg.text || " ", reply_markup }),
      });
  const data: any = await res.json().catch(() => ({}));
  return { delivered: !!data.ok, detail: data.description };
}

// ---------------- WhatsApp Cloud API ----------------
export function parseWhatsApp(body: any): InboundEvent[] {
  const events: InboundEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
        events.push({
          channel: "whatsapp",
          contactId: m.from,
          contactName: names.get(m.from),
          text: reply?.title ?? m.text?.body ?? m.button?.text ?? "",
          buttonId: reply?.id ?? m.button?.payload,
        });
      }
    }
  }
  return events;
}

export function whatsappPayload(to: string, msg: OutMessage) {
  const buttons = msg.buttons ?? [];
  if (buttons.length > 0 && buttons.length <= 3) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: msg.text.slice(0, 1024) || " " },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.label.slice(0, 20) } })) },
      },
    };
  }
  if (buttons.length > 3 && buttons.length <= 10) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: msg.text.slice(0, 1024) || " " },
        action: { button: "Options", sections: [{ title: "Options", rows: buttons.map((b) => ({ id: b.id.slice(0, 200), title: b.label.slice(0, 24) })) }] },
      },
    };
  }
  if (msg.imageUrl) return { messaging_product: "whatsapp", to, type: "image", image: { link: msg.imageUrl, caption: buttonsAsText(msg) } };
  return { messaging_product: "whatsapp", to, type: "text", text: { body: buttonsAsText(msg) } };
}

export async function sendWhatsApp(http: Fetch, cfg: { phoneNumberId: string; accessToken: string }, to: string, msg: OutMessage): Promise<DeliveryResult> {
  const res = await http(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(whatsappPayload(to, msg)),
  });
  const data: any = await res.json().catch(() => ({}));
  return { delivered: res.ok, detail: data?.error?.message };
}

// ---------------- hub ----------------
export class ChannelHub {
  constructor(
    private store: Store,
    private http: Fetch = fetch,
  ) {}

  channel(agentId: string, kind: string): ChannelConfig | undefined {
    return this.store.listChannels(agentId).find((c) => c.kind === kind && c.enabled);
  }

  /** Deliver an outbox to a contact. Web chat and test messages are returned in the HTTP response instead. */
  async deliver(agentId: string, kind: string, to: string, msgs: OutMessage[]): Promise<DeliveryResult[]> {
    const out: DeliveryResult[] = [];
    for (const m of msgs) out.push(await this.send(agentId, kind, to, m));
    return out;
  }

  async send(agentId: string, kind: string, to: string, msg: OutMessage): Promise<DeliveryResult> {
    if (kind === "webchat" || kind === "test" || kind === "webhook" || kind === "schedule") return { delivered: true, detail: "returned in response" };
    const ch = this.channel(agentId, kind);
    if (!ch) {
      this.store.logIntegration({ agentId, service: kind, action: "send", mode: "sandbox", request: { to, msg }, response: { note: "channel not connected" } });
      return { delivered: false, detail: `${kind} not connected (logged in sandbox)` };
    }
    try {
      const res =
        kind === "telegram"
          ? await sendTelegram(this.http, ch.config.botToken, to, msg)
          : kind === "whatsapp"
            ? await sendWhatsApp(this.http, { phoneNumberId: ch.config.phoneNumberId, accessToken: ch.config.accessToken }, to, msg)
            : { delivered: false, detail: `unknown channel ${kind}` };
      this.store.logIntegration({ agentId, service: kind, action: "send", mode: "live", request: { to, text: msg.text }, response: res });
      return res;
    } catch (err: any) {
      return { delivered: false, detail: String(err.message ?? err) };
    }
  }

  /** Telegram: point the bot's webhook at this server. */
  async registerTelegramWebhook(token: string, url: string, secret: string) {
    const res = await this.http(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "callback_query"] }),
    });
    return res.json();
  }
}

/** Long polling for local development, when there is no public URL for webhooks. */
export class TelegramPoller {
  private stopped = false;
  private offset = 0;
  constructor(
    private token: string,
    private onUpdate: (u: any) => Promise<void>,
    private http: Fetch = fetch,
  ) {}
  async start() {
    await this.http(`https://api.telegram.org/bot${this.token}/deleteWebhook`).catch(() => {});
    while (!this.stopped) {
      try {
        const res = await this.http(`https://api.telegram.org/bot${this.token}/getUpdates?timeout=25&offset=${this.offset}`);
        const data: any = await res.json();
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1;
          await this.onUpdate(u).catch((e) => console.error("[telegram] update failed", e));
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  stop() {
    this.stopped = true;
  }
}
