// Display names for a session's model and reasoning effort.

/** "claude-opus-5-5" → "Opus 5.5"; "claude-sonnet-5-5[1m]" → "Sonnet 5.5 1M"; unknown ids are shown as given. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  const ver = m[3] ? `${m[2]}.${m[3]}` : m[2];
  return `${name} ${ver}${/\[1m\]|-1m\b/i.test(id) ? " 1M" : ""}`;
}

const EFFORT: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" };

export function effortLabel(e: string | null | undefined): string {
  if (!e) return "—";
  return EFFORT[e.toLowerCase()] ?? e[0].toUpperCase() + e.slice(1);
}
