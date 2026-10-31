import { useEffect, useState, type ReactNode } from "react";
import { Globe, Send, MessageCircle, Hash, Gamepad2, Sheet, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api, type Agent } from "../api";

interface Channel {
  id: string;
  kind: string;
  enabled: boolean;
  config: Record<string, string>;
}

export default function Channels({ agent }: { agent: Agent }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const load = () => api<Channel[]>(`/api/agents/${agent.id}/channels`).then(setChannels);
  useEffect(() => {
    load();
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const get = (k: string) => channels.find((c) => c.kind === k);
  const origin = location.origin;

  return (
    <div className="page">
      <Section icon={<Globe size={16} />} title="Website chat" note="Paste before </body> on any page. Right-to-left aware, keeps history per visitor." status="ready">
        <code className="block">{`<script src="${origin}/widget.js" data-agent="${agent.id}" data-color="#b4441f" async></script>`}</code>
        <a href={`/widget-demo.html?agent=${agent.id}`} target="_blank" rel="noreferrer" className="small">
          Open a demo page with the widget
        </a>
      </Section>

      <ChannelForm
        icon={<Send size={16} />}
        title="Telegram"
        note="Create a bot with @BotFather and paste its token."
        kind="telegram"
        agentId={agent.id}
        channel={get("telegram")}
        onSaved={load}
        fields={[{ key: "botToken", label: "Bot token" }]}
        extra={
          <>
            <p className="small soft">Register a public HTTPS webhook, or run the server with <code>BOTLOOM_TELEGRAM_POLLING=1</code> during local development.</p>
            <TelegramRegister agentId={agent.id} />
          </>
        }
      />

      <ChannelForm
        icon={<MessageCircle size={16} />}
        title="WhatsApp"
        note="WhatsApp Cloud API. Webhook signatures are verified with the app secret."
        kind="whatsapp"
        agentId={agent.id}
        channel={get("whatsapp")}
        onSaved={load}
        fields={[
          { key: "phoneNumberId", label: "Phone number ID" },
          { key: "accessToken", label: "Access token" },
          { key: "appSecret", label: "App secret" },
          { key: "verifyToken", label: "Verify token (generated if empty)" },
        ]}
        extra={
          <p className="small soft">
            In Meta for Developers, set the callback URL to <code>{origin}/webhooks/whatsapp/{agent.id}</code> and subscribe to <code>messages</code>. Up to 3 buttons render as reply buttons, 4 to 10 as a list, more as a numbered menu.
          </p>
        }
      />

      <ChannelForm
        icon={<Hash size={16} />}
        title="Slack"
        note="Team alerts from the Notify step: new leads, bookings, handoffs."
        kind="slack"
        agentId={agent.id}
        channel={get("slack")}
        onSaved={load}
        fields={[{ key: "webhookUrl", label: "Incoming webhook URL" }]}
      />

      <ChannelForm
        icon={<Gamepad2 size={16} />}
        title="Discord"
        note="Server settings, Integrations, Webhooks. Used by the Notify step."
        kind="discord"
        agentId={agent.id}
        channel={get("discord")}
        onSaved={load}
        fields={[{ key: "webhookUrl", label: "Channel webhook URL" }]}
      />

      <Section icon={<Sheet size={16} />} title="Google" note="Sheets, Calendar and Gmail, configured once for the server.">
        <p className="small soft">
          Set <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> and share the sheet or calendar with the service account, or use an OAuth refresh token (<code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REFRESH_TOKEN</code>). Without them every Google step runs in sandbox mode and is recorded under Runs, Integration calls.
        </p>
      </Section>

      <Section icon={<Webhook size={16} />} title="Webhooks" note="Orders, forms, CRMs, Make or Zapier.">
        <p className="small soft">
          Add an On webhook trigger and send events to <code>{origin}/hooks/{agent.id}/&lt;key&gt;</code>. The HTTP request step calls any REST API back.
        </p>
      </Section>
    </div>
  );
}

function Section({ icon, title, note, status, children }: { icon: ReactNode; title: string; note: string; status?: "ready" | "connected" | "off"; children: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h2>
          {icon}
          {title}
          {status === "connected" && <span className="tag ok">Connected</span>}
          {status === "ready" && <span className="tag">Ready</span>}
        </h2>
        <p>{note}</p>
      </header>
      <div className="stack">{children}</div>
    </section>
  );
}

function ChannelForm({
  icon,
  title,
  note,
  kind,
  agentId,
  channel,
  fields,
  extra,
  onSaved,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  kind: string;
  agentId: string;
  channel?: Channel;
  fields: { key: string; label: string }[];
  extra?: ReactNode;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues(channel?.config ?? {}), [channel]);
  return (
    <Section icon={icon} title={title} note={note} status={channel ? "connected" : "off"}>
      {fields.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}</span>
          <input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} autoComplete="off" spellCheck={false} />
        </label>
      ))}
      <div className="row">
        <button
          onClick={async () => {
            await api(`/api/agents/${agentId}/channels/${kind}`, { method: "PUT", json: { config: values } });
            toast.success(`${title} saved`);
            onSaved();
          }}
        >
          Save {title}
        </button>
      </div>
      {extra}
    </Section>
  );
}

function TelegramRegister({ agentId }: { agentId: string }) {
  const [url, setUrl] = useState(location.origin.startsWith("https") ? location.origin : "");
  const [res, setRes] = useState("");
  return (
    <div className="row">
      <label className="sr-only" htmlFor="tg-url">
        Public HTTPS address of this server
      </label>
      <input id="tg-url" style={{ flex: 1, width: "auto" }} placeholder="https://bots.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button
        onClick={async () => {
          try {
            const r = await api(`/api/agents/${agentId}/channels/telegram/register`, { method: "POST", json: { publicUrl: url } });
            setRes(r.ok ? "Webhook registered" : r.description ?? JSON.stringify(r));
          } catch (e: any) {
            setRes(e.message);
          }
        }}
      >
        Register webhook
      </button>
      {res && <span className="small soft" role="status">{res}</span>}
    </div>
  );
}
