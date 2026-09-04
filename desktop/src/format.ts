// Human-friendly formatting for a non-technical audience. No ISO strings, no
// 24-hour times, no internal agent ids in the UI.

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A YYYY-MM-DD (optionally with time) → "Sep 8", "Fri, Sep 8", "Today". */
export function friendlyDate(iso: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffDays = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: opts.weekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: thisYear ? undefined : "numeric",
  });
}

/** "HH:MM" (24h) → "3:30 PM". */
export function friendlyTime(hm: string | null | undefined): string {
  if (!hm) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(hm);
  if (!m) return hm;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** date (+ optional time) → "Fri, Sep 8 · 3:30 PM". */
export function friendlyDateTime(date: string | null | undefined, time?: string | null): string {
  const d = friendlyDate(date, { weekday: true });
  const t = friendlyTime(time);
  return t ? `${d} · ${t}` : d;
}

/** How overdue / soon a due date is, for sorting + a subtle label. */
export function dueBucket(date: string | null | undefined): "overdue" | "today" | "soon" | "later" | "none" {
  if (!date) return "none";
  const d = new Date(`${date.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "none";
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 3) return "soon";
  return "later";
}

/** An ISO timestamp → "2m ago", "3:42 PM", "Yesterday", "Sep 1". */
export function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A calendar-style day heading for grouping a log: "Today", "Yesterday", "Monday", "August 30". */
export function dayHeading(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

const ACTOR_LABELS: Record<string, string> = {
  user: "You",
  "family-planner": "Assistant",
  "task-agent": "Events",
  "document-agent": "Documents",
  "notes-agent": "Board",
  "builder-agent": "Tool builder",
  "tools-agent": "Tools",
};

/** Internal agent id → a word a family member understands. */
export function humanActor(actor: string): string {
  return ACTOR_LABELS[actor] ?? actor.replace(/-/g, " ");
}
