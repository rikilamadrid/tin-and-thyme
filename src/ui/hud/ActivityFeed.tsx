import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ActivityEvent, ActivityType } from "../../data/types";
import { useOffice } from "../../store/office";
import { ago, useNow } from "../kit";

const ICON: Record<ActivityType, [string, string]> = {
  "task.assigned": ["▸", "#c9b6ff"],
  "task.started": ["●", "#29adff"],
  "task.created": ["+", "#c9b6ff"],
  "agent.needs-input": ["!", "#ff5c86"],
  "agent.answered": ["✓", "#6cf08a"],
  message: ["✉", "#ff77a8"],
  "pr.opened": ["⇡", "#ffec27"],
  "review.started": ["◎", "#ffc14d"],
  "review.passed": ["✓", "#6cf08a"],
  "review.changes": ["✗", "#ff5c86"],
  "pr.merged": ["⇢", "#6cf08a"],
  deploy: ["▲", "#3ee0d0"],
  session: ["◆", "#9aa6d1"],
  config: ["⚙", "#9aa6d1"],
};

const EMPTY: ActivityEvent[] = [];

/** Fixed height: a busy run scrolls inside the feed and never moves the rest of the layout. */
export const ACTIVITY_H = 220;
export const ACTIVITY_W = 280;

/** Bottom of the left column, under the roster and outside the room (as in the original JSM HQ). */
export function ActivityFeed() {
  const activity = useOffice((s) => s.snap?.activity ?? EMPTY);
  const now = useNow(1000);
  const reduce = useReducedMotion();
  const items = activity.slice(0, 50);

  return (
    <section
      aria-label="Activity"
      className="fixed bottom-4 left-4 z-10 flex flex-col rounded-[6px] bg-[#0c1226] px-2.5 pb-1 pt-2 font-[system-ui] text-[#eef6ff] ring-1 ring-[#26335c]"
      style={{ width: ACTIVITY_W, height: ACTIVITY_H }}
    >
      <div className="mb-1 flex shrink-0 items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#a8b8d8]">
        <i className="led" />
        Activity
        <span className="font-semibold normal-case tracking-normal text-[#7f8bb5]">{activity.length ? `· ${activity.length} recent` : ""}</span>
      </div>
      <ul className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pr-1 text-[13px] leading-[18px]" aria-live="polite" tabIndex={0} aria-label="Recent activity">
        <AnimatePresence initial={false}>
          {items.map((e) => {
            const [icon, color] = ICON[e.type];
            return (
              <motion.li
                key={e.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
                className="flex gap-2 border-t border-[rgba(185,195,230,0.12)] py-[2px] first:border-t-0"
              >
                <span className="w-3 shrink-0 text-center" style={{ color }}>
                  {icon}
                </span>
                <span className="min-w-0 flex-1 truncate" title={e.text}>
                  {e.text}
                </span>
                <time className="shrink-0 text-[12px] tabular-nums text-[#7f8bb5]">{ago(e.at, now)}</time>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
