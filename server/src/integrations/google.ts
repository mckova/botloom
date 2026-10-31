// Google Workspace integration without the googleapis dependency.
// Auth: a service account (GOOGLE_SERVICE_ACCOUNT_JSON) signed with node:crypto, or an OAuth refresh
// token (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN). Without credentials every
// call runs in sandbox mode: it is recorded in the integration log and returns a realistic result.
import { createSign } from "node:crypto";
import type { Store } from "../db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

type Fetch = typeof fetch;

export class GoogleClient {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private store: Store,
    private env: NodeJS.ProcessEnv = process.env,
    private http: Fetch = fetch,
  ) {}

  get live(): boolean {
    return !!(this.env.GOOGLE_SERVICE_ACCOUNT_JSON || this.env.GOOGLE_REFRESH_TOKEN);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    let body: URLSearchParams;
    if (this.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(this.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const iat = Math.floor(Date.now() / 1000);
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const claims: Record<string, any> = { iss: sa.client_email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 };
      if (this.env.GOOGLE_IMPERSONATE) claims.sub = this.env.GOOGLE_IMPERSONATE; // domain-wide delegation (needed for Gmail)
      const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
      const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
      body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` });
    } else {
      body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: this.env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: this.env.GOOGLE_REFRESH_TOKEN ?? "",
      });
    }
    const res = await this.http("https://oauth2.googleapis.com/token", { method: "POST", body });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Google auth failed: ${data.error_description ?? data.error ?? res.status}`);
    this.token = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async call(agentId: string, action: string, url: string, payload: any, sandboxResult: any) {
    if (!this.live) {
      this.store.logIntegration({ agentId, service: "google", action, mode: "sandbox", request: payload, response: sandboxResult });
      return { ...sandboxResult, sandbox: true };
    }
    const res = await this.http(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data: any = await res.json().catch(() => ({}));
    this.store.logIntegration({ agentId, service: "google", action, mode: "live", request: payload, response: data });
    if (!res.ok) throw new Error(`Google ${action} failed: ${data?.error?.message ?? res.status}`);
    return data;
  }

  appendRow(agentId: string, spreadsheetId: string, sheet: string, values: any[]) {
    const range = encodeURIComponent(`${sheet}!A1`);
    return this.call(
      agentId,
      "sheets.append",
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
      { values: [values] },
      { updates: { updatedRows: 1, updatedRange: `${sheet}!A?` } },
    );
  }

  createEvent(agentId: string, calendarId: string, ev: { summary: string; start: string; durationMin: number; description?: string; attendeeEmail?: string }) {
    const start = new Date(ev.start);
    if (isNaN(start.getTime())) throw new Error(`Invalid start time: ${ev.start}`);
    const end = new Date(start.getTime() + ev.durationMin * 60_000);
    const payload: any = {
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };
    if (ev.attendeeEmail) payload.attendees = [{ email: ev.attendeeEmail }];
    return this.call(
      agentId,
      "calendar.create",
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      payload,
      { id: `evt_sandbox_${Date.now()}`, status: "confirmed", htmlLink: "https://calendar.google.com/", start: payload.start, end: payload.end },
    );
  }

  sendEmail(agentId: string, to: string, subject: string, body: string) {
    const mime = [`To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
    return this.call(
      agentId,
      "gmail.send",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { raw: Buffer.from(mime).toString("base64url") },
      { id: `msg_sandbox_${Date.now()}`, labelIds: ["SENT"], to, subject },
    );
  }
}
