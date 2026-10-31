import {
  MessageSquare,
  Webhook,
  CalendarClock,
  Send,
  CircleHelp,
  UserRound,
  Square,
  GitBranch,
  Variable,
  Timer,
  Bot,
  Route,
  ScanText,
  BookOpen,
  PenLine,
  Globe,
  Sheet,
  TableProperties,
  CalendarPlus,
  Mail,
  Megaphone,
  Circle,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "trigger.message": MessageSquare,
  "trigger.webhook": Webhook,
  "trigger.schedule": CalendarClock,
  "message.send": Send,
  "message.ask": CircleHelp,
  "message.handoff": UserRound,
  "flow.end": Square,
  "logic.condition": GitBranch,
  "logic.set": Variable,
  "logic.delay": Timer,
  "ai.agent": Bot,
  "ai.intent": Route,
  "ai.extract": ScanText,
  "ai.generate": PenLine,
  "kb.search": BookOpen,
  "http.request": Globe,
  "google.sheets.append": Sheet,
  "google.sheets.lookup": TableProperties,
  "google.calendar.create": CalendarPlus,
  "gmail.send": Mail,
  "channel.notify": Megaphone,
};

// Category hues are semantic (what kind of step), muted so the brick accent stays reserved for actions.
export const CATEGORY_COLORS: Record<string, string> = {
  trigger: "#4d6b2f",
  message: "#3f5f73",
  logic: "#8a6a1f",
  ai: "#8a3f2a",
  integration: "#55606b",
};

export function NodeIcon({ type, size = 14 }: { type: string; size?: number }) {
  const Icon = ICONS[type] ?? Circle;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}
