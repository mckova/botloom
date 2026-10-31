import { useEffect, useState } from "react";
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
    <div className="pad narrow">
      <div className="card">
        <h3>🌐 Website chat widget</h3>
        <p className="muted small">Paste before &lt;/body&gt; on any website. Works out of the box, RTL aware.</p>
        <code className="block">{`<script src="${origin}/widget.js" data-agent="${agent.id}" data-color="#6d5dfc" async></script>`}</code>
        <a href={`/widget-demo.html?agent=${agent.id}`} target="_blank" rel="noreferrer">
          Open a demo page with the widget →
        </a>
      </div>

      <ChannelForm
        title="✈️ Telegram"
        kind="telegram"
        agentId={agent.id}
        channel={get("telegram")}
        onSaved={load}
        fields={[{ key: "botToken", label: "Bot token (from @BotFather)" }]}
        help={
          <>
            <p className="small">1. Create a bot with @BotFather and paste its token. 2. Either register a public HTTPS webhook below, or run the server with <code>BOTLOOM_TELEGRAM_POLLING=1</code> for local development.</p>
            <TelegramRegister agentId={agent.id} />
          </>
        }
      />

      <ChannelForm
        title="🟢 WhatsApp (Cloud API)"
        kind="whatsapp"
        agentId={agent.id}
        channel={get("whatsapp")}
        onSaved={load}
        fields={[
          { key: "phoneNumberId", label: "Phone number ID" },
          { key: "accessToken", label: "Access token" },
          { key: "appSecret", label: "App secret (verifies webhook signatures)" },
          { key: "verifyToken", label: "Verify token (auto-generated if empty)" },
        ]}
        help={
          <p className="small">
            In Meta for Developers → WhatsApp → Configuration, set the callback URL to <code>{origin}/webhooks/whatsapp/{agent.id}</code> and the verify token shown above, and subscribe to <code>messages</code>. Up to 3 buttons become reply buttons, 4-10 a list, more a numbered text menu.
          </p>
        }
      />

      <div className="card">
        <h3>🔗 Google (Sheets, Calendar, Gmail)</h3>
        <p className="small">
          Server-wide credentials, set as environment variables: <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (share the sheet / calendar with the service account) or an OAuth refresh token (<code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REFRESH_TOKEN</code>). Without them, Google nodes run in <b>sandbox mode</b> and every call is visible under Runs → Integration calls.
        </p>
      </div>
      <div className="card">
        <h3>🪝 Webhooks & other systems</h3>
        <p className="small">
          Add an <b>On webhook</b> trigger to receive events from your store, CRM, forms, Make or Zapier at <code>{origin}/hooks/{agent.id}/&lt;key&gt;</code>. Use the <b>HTTP request</b> node to call any REST API.
        </p>
      </div>
    </div>
  );
}

function ChannelForm({ title, kind, agentId, channel, fields, help, onSaved }: { title: string; kind: string; agentId: string; channel?: Channel; fields: { key: string; label: string }[]; help: React.ReactNode; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  useEffect(() => setValues(channel?.config ?? {}), [channel]);
  return (
    <div className="card">
      <div className="row">
        <h3>{title}</h3>
        <span className="spacer" />
        {channel ? <span className="pill ok">connected</span> : <span className="pill">not connected</span>}
      </div>
      {fields.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}</span>
          <input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
        </label>
      ))}
      <div className="row">
        <button
          className="primary"
          onClick={async () => {
            await api(`/api/agents/${agentId}/channels/${kind}`, { method: "PUT", json: { config: values } });
            setMsg("Saved");
            onSaved();
          }}
        >
          Save
        </button>
        <span className="small ok">{msg}</span>
      </div>
      {help}
    </div>
  );
}

function TelegramRegister({ agentId }: { agentId: string }) {
  const [url, setUrl] = useState(location.origin.startsWith("https") ? location.origin : "");
  const [res, setRes] = useState("");
  return (
    <div className="row">
      <input placeholder="https://your-public-url" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button
        onClick={async () => {
          try {
            const r = await api(`/api/agents/${agentId}/channels/telegram/register`, { method: "POST", json: { publicUrl: url } });
            setRes(r.ok ? "Webhook registered ✓" : r.description ?? JSON.stringify(r));
          } catch (e: any) {
            setRes(e.message);
          }
        }}
      >
        Register webhook
      </button>
      <span className="small">{res}</span>
    </div>
  );
}
