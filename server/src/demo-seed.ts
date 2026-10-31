// First-run demo data: the three example agents plus a handful of real conversations, so the
// inbox, brief and answer explanations are populated the moment the app opens.
import type { FastifyInstance } from "fastify";
import type { Store } from "./db.js";

export async function seedDemo(app: FastifyInstance, store: Store) {
  if (store.listAgents().length > 0) return false;
  const post = async (url: string, payload: unknown = {}) => (await app.inject({ method: "POST", url, payload: payload as any })).json();
  const clinic = await post("/api/agents/from-template/clinic-receptionist");
  const shop = await post("/api/agents/from-template/ai-sales-agent");
  await post("/api/agents/from-template/order-automation");

  const web = (id: string, visitorId: string, name: string, text: string) => post(`/widget/${id}/message`, { visitorId, name, text });
  await web(shop.id, "visitor-daniel", "Daniel Ross", "How long does express shipping take?");
  await web(shop.id, "visitor-daniel", "Daniel Ross", "Remember that I always pay by bank transfer");
  await web(shop.id, "visitor-daniel", "Daniel Ross", "My order arrived with a cracked lid. Can a human help me?");
  await web(shop.id, "visitor-maya", "Maya Cohen", "Is there a warranty on headphones?");
  await web(shop.id, "visitor-omer", "Omer Katz", "Where is my order 1042?");

  // The clinic talks to patients on WhatsApp. No credentials are set, so replies are logged in the sandbox.
  store.upsertChannel(clinic.id, "whatsapp", {}, true);
  const wa = (text: string, buttonId?: string) =>
    post(`/webhooks/whatsapp/${clinic.id}`, {
      entry: [{ changes: [{ value: { contacts: [{ wa_id: "447700900123", profile: { name: "נועה לוי" } }], messages: [buttonId ? { from: "447700900123", interactive: { button_reply: { id: buttonId, title: text } } } : { from: "447700900123", text: { body: text } }] } }] }],
    });
  await wa("שלום");
  await wa("שאלה", "question");
  await wa("כמה עולה טיפול פיזיותרפיה?");
  await wa("אני צריכה תור דחוף מחר בבוקר, אפשר נציג?");
  return true;
}
