// Ready-made agents. They double as product demos and as end-to-end test fixtures.
import type { Flow, FlowEdge, FlowNode } from "./engine/types.js";

export interface Template {
  id: string;
  name: string;
  description: string;
  language: "he" | "en";
  systemPrompt?: string;
  flow: Flow;
  docs?: { title: string; content: string }[];
}

function build(spec: [string, string, Record<string, any>, number, number][], links: [string, string, string?][]): Flow {
  const nodes: FlowNode[] = spec.map(([id, type, config, x, y]) => ({ id, type, config, position: { x: Math.round(x * 280), y: Math.round(y * 160) } }));
  const edges: FlowEdge[] = links.map(([source, target, port], i) => ({ id: `e${i + 1}`, source, target, sourcePort: port ?? "out" }));
  return { nodes, edges };
}

const CLINIC_KB = `שעות פעילות: ראשון עד חמישי 08:00-20:00, שישי 08:00-13:00. בשבת המרפאה סגורה.

כתובת: רחוב הרצל 10, תל אביב. יש חניה בתשלום בחניון הסמוך.

מחירים: טיפול פיזיותרפיה 45 דקות 280 ש"ח. הערכה ראשונית 350 ש"ח. מנוי 10 טיפולים 2,500 ש"ח.

ביטול תור: ניתן לבטל עד 24 שעות לפני התור ללא חיוב. ביטול מאוחר יותר יחויב ב-50%.

קופות חולים: יש הסדר עם מכבי ומאוחדת. יש להביא הפניה מרופא.`;

const SHOP_KB = `Shipping: free shipping on orders over $50. Standard delivery takes 3-5 business days; express (1-2 days) costs $12.

Returns: items can be returned within 30 days in original condition. Refunds are issued to the original payment method within 5 business days.

Opening hours: online support is available Sunday to Thursday, 9:00-18:00.

Warranty: all electronics have a 12-month manufacturer warranty.`;

export const TEMPLATES: Template[] = [
  {
    id: "clinic-receptionist",
    name: "מרפאת תנועה: קבלה",
    description: "Hebrew receptionist: a guided booking path with double-booking protection, plus a Claude agent that answers from the knowledge base, checks real calendar availability, books, remembers patient preferences and hands off to a human.",
    language: "he",
    systemPrompt: "את המזכירה הדיגיטלית של מרפאת 'תנועה' לפיזיותרפיה. עני בעברית, בקצרה ובחום.",
    docs: [{ title: "מידע על המרפאה", content: CLINIC_KB }],
    flow: build(
      [
        ["start", "trigger.message", {}, 0, 1.2],
        ["menu", "message.ask", { question: "שלום, אני המזכירה הדיגיטלית של מרפאת תנועה. במה אפשר לעזור?", variable: "choice", validate: "choice", choices: "book: קביעת תור\nquestion: שאלה על המרפאה\nhuman: לדבר עם נציג", retryText: "אפשר לבחור באחת האפשרויות או לכתוב את המספר שלה" }, 1, 1.2],
        ["askName", "message.ask", { question: "מעולה! מה השם המלא?", variable: "full_name", validate: "text" }, 2, 0],
        ["askPhone", "message.ask", { question: "ומה מספר הטלפון?", variable: "phone", validate: "phone", retryText: "המספר לא נראה תקין, אפשר לנסות שוב? (למשל 0501234567)" }, 3, 0],
        ["askDate", "message.ask", { question: "לאיזה מועד? כתבו תאריך ושעה בפורמט 2026-11-03 10:30", variable: "datetime", validate: "date", retryText: "לא הצלחתי להבין את התאריך. נסו בפורמט 2026-11-03 10:30" }, 4, 0],
        ["book", "google.calendar.create", { calendarId: "primary", summary: "פיזיותרפיה: {{vars.full_name}}", start: "{{vars.datetime}}", durationMin: 45, checkBusy: true }, 5, 0],
        ["busy", "message.send", { text: "המועד הזה כבר תפוס. בואו ננסה מועד אחר." }, 4, -1.15],
        ["confirm", "message.send", { text: "נקבע תור ל{{vars.full_name}} ב-{{vars.datetime}}. נשלח תזכורת יום לפני. להתראות!" }, 5, 1.15],
        ["notify", "channel.notify", { channel: "telegram", to: "OWNER_CHAT_ID", text: "תור חדש: {{vars.full_name}} ({{vars.phone}}) ב-{{vars.datetime}}" }, 5, 2.3],
        ["save", "google.sheets.append", { spreadsheetId: "demo-sheet", sheet: "תורים", columns: "{{now.iso}}\n{{vars.full_name}}\n{{vars.phone}}\n{{vars.datetime}}\n{{contact.channel}}" }, 5, 3.45],
        ["bookFail", "message.send", { text: "לא הצלחתי לקבוע כרגע. נציג יחזור אליכם בהקדם." }, 4, 1.2],
        ["askQ", "message.ask", { question: "בשמחה, מה השאלה?", variable: "question", validate: "text" }, 2, 1.6],
        ["ai", "ai.agent", { input: "{{vars.question}}", instructions: "עני על שאלות לגבי המרפאה רק על סמך מאגר הידע. אם המטופל רוצה לקבוע תור, בדקי זמינות עם check_availability, הציעי 2-3 מועדים פנויים, ואחרי שבחר ונתן שם קבעי עם book_appointment. שמרי עם remember העדפות קבועות (למשל שעות מועדפות או מטפל מועדף).", tools: ["knowledge_search", "check_availability", "book_appointment", "remember", "handoff_to_human"], loop: true, calendarId: "primary", durationMin: 45, dayStart: "08:00", dayEnd: "19:00" }, 3, 1.6],
        ["handoff", "message.handoff", { text: "מעבירה אותך לנציג אנושי, נחזור אליך תוך כמה דקות." }, 4, 2.6],
        ["fallback", "message.handoff", { text: "נראה שהתקשינו להבין, נציג יחזור אליכם בהקדם." }, 2, 3.2],
      ],
      [
        ["start", "menu"],
        ["menu", "askName", "book"],
        ["menu", "askQ", "question"],
        ["askQ", "ai"],
        ["menu", "handoff", "human"],
        ["menu", "fallback", "invalid"],
        ["askName", "askPhone"],
        ["askPhone", "askDate"],
        ["askDate", "book"],
        ["book", "confirm"],
        ["book", "bookFail", "error"],
        ["book", "busy", "busy"],
        ["busy", "askDate"],
        ["confirm", "notify"],
        ["notify", "save"],
        ["ai", "handoff", "handoff"],
      ],
    ),
  },
  {
    id: "ai-sales-agent",
    name: "Gadget Garden support",
    description: "Autonomous Claude agent for an online store: answers from the FAQ, looks up orders through an API, saves leads to Google Sheets, remembers returning customers and escalates to a human with Telegram and Slack alerts.",
    language: "en",
    systemPrompt: "You are Nova, the assistant of Gadget Garden, an online electronics store.",
    docs: [{ title: "Store FAQ", content: SHOP_KB }],
    flow: build(
      [
        ["start", "trigger.message", {}, 0, 1],
        ["agent", "ai.agent", { instructions: "Help customers with orders, shipping and returns. When someone is interested in a product or a business deal, collect their name and phone or email and call save_lead.", tools: ["knowledge_search", "lookup_order", "save_lead", "remember", "handoff_to_human"], loop: true, spreadsheetId: "demo-sheet", sheetName: "Leads" }, 1, 1],
        ["handoff", "channel.notify", { channel: "telegram", to: "SUPPORT_CHAT_ID", text: "{{contact.name}} on {{contact.channel}} needs a human: {{vars.handoff_reason}}" }, 2, 1],
        ["slack", "channel.notify", { channel: "slack", to: "", text: "Handoff: {{contact.name}} ({{contact.channel}}): {{vars.handoff_reason}}" }, 2, 2],
        ["bye", "message.send", { text: "A teammate will take it from here. Thanks for your patience!" }, 3, 1],
      ],
      [
        ["start", "agent"],
        ["agent", "handoff", "handoff"],
        ["agent", "slack", "handoff"],
        ["handoff", "bye"],
      ],
    ),
  },
  {
    id: "order-automation",
    name: "Gadget Garden orders",
    description: "No-chat automation: a store webhook logs each order to Sheets, Claude writes a personal confirmation email, VIP orders are flagged on Telegram; a daily schedule sends a morning report.",
    language: "en",
    flow: build(
      [
        ["hook", "trigger.webhook", { key: "new-order" }, 0, 0],
        ["vars", "logic.set", { assign: { customer: "{{message.payload.customer}}", email: "{{message.payload.email}}", total: "{{message.payload.total}}", order: "{{message.payload.id}}" } }, 1, 0],
        ["sheet", "google.sheets.append", { spreadsheetId: "demo-sheet", sheet: "Orders", columns: "{{now.iso}}\n{{vars.order}}\n{{vars.customer}}\n{{vars.total}}" }, 2, 0],
        ["write", "ai.generate", { prompt: "Write a short, warm order confirmation email body for {{vars.customer}}, who just ordered items worth ${{vars.total}} (order {{vars.order}}). Items: {{message.payload.items | json}}. Mention we will email when it ships. Sign as Gadget Garden.", instructions: "Plain text, 3-5 sentences, no subject line, no placeholders.", effort: "low", saveAs: "email_body" }, 3, 0],
        ["mail", "gmail.send", { to: "{{vars.email}}", subject: "Order {{vars.order}} confirmed", body: "{{vars.email_body}}" }, 4, 0],
        ["mailPlain", "gmail.send", { to: "{{vars.email}}", subject: "Order {{vars.order}} confirmed", body: "Hi {{vars.customer}},\n\nThanks for your order of ${{vars.total}}. We'll let you know when it ships.\n\nGadget Garden" }, 4, 1],
        ["vip", "logic.condition", { left: "{{vars.total}}", op: "gt", right: "500" }, 3, 2.2],
        ["alert", "channel.notify", { channel: "telegram", to: "OWNER_CHAT_ID", text: "VIP order {{vars.order}}: ${{vars.total}} from {{vars.customer}}" }, 4, 2.2],
        ["daily", "trigger.schedule", { mode: "daily", time: "08:00" }, 0, 2],
        ["report", "channel.notify", { channel: "telegram", to: "OWNER_CHAT_ID", text: "Good morning. Yesterday's orders are in the Orders sheet: https://docs.google.com/spreadsheets/" }, 1, 2],
      ],
      [
        ["hook", "vars"],
        ["vars", "sheet"],
        ["sheet", "write"],
        ["write", "mail"],
        ["write", "mailPlain", "error"],
        ["sheet", "vip"],
        ["vip", "alert", "true"],
        ["daily", "report"],
      ],
    ),
  },
];
