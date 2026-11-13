import { useEffect, useRef, useState } from "react";
import type { ActionItem, OfficeSnapshot } from "../../data/types";
import { requestsByShelf } from "../../data/requests";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { ago, Dot, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { ReadyToDeliverList } from "../delivery/DeliveryEntries";

/** Everything waiting on the user: agents' action items first, then the other things that need them. */
export function ActionItemsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(10_000);
  const [showClosed, setShowClosed] = useState(false);
  if (!snap) return null;
  const a = selectAttention(snap);
  const agent = (id: string) => snap.config.team.find((x) => x.id === id);
  const closed = (snap.actionItems ?? [])
    .filter((i) => i.status !== "open")
    .sort((x, y) => (y.closedAt ?? "").localeCompare(x.closedAt ?? ""))
    .slice(0, 20);
  // Waiting items first, then oldest first (what's been waiting longest).
  const open = [...a.items].sort((x, y) => Number(y.waiting) - Number(x.waiting) || x.at.localeCompare(y.at));
  const shelves = requestsByShelf(snap.actionItems, now);
  const others = a.asking.length + a.access.length + a.blocked.length + a.readyPrs.length;

  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Action items</b>
        <span className="text-[13px] text-muted">{a.total ? `${a.total} waiting on you` : "Nothing waiting on you"}</span>
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>From agents</SectionTitle>
        {open.length === 0 ? (
          <p className="mb-4 text-[13px] text-muted">No requests. When an agent needs you to do something outside its sandbox, it shows up here.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {open.map((item) => (
              <Item key={item.id} item={item} from={agent(item.fromId)} now={now} snap={snap} />
            ))}
          </ul>
        )}
        {shelves.awaiting.length > 0 && (
          <>
            <SectionTitle>Answered · waiting for Pathfinder</SectionTitle>
            <ul className="mb-4 flex flex-col gap-2">
              {shelves.awaiting.map((item) => (
                <Item key={item.id} item={item} from={agent(item.fromId)} now={now} snap={snap} />
              ))}
            </ul>
          </>
        )}
        {shelves.snoozed.length > 0 && (
          <>
            <SectionTitle>Snoozed</SectionTitle>
            <ul className="mb-4 flex flex-col gap-2">
              {shelves.snoozed.map((item) => (
                <Item key={item.id} item={item} from={agent(item.fromId)} now={now} snap={snap} />
              ))}
            </ul>
          </>
        )}

        <ReadyToDeliverList />

        {others > 0 && (
          <>
            <SectionTitle>Also waiting on you</SectionTitle>
            <ul className="mb-4 flex flex-col gap-1.5 text-[14px]">
              {a.asking.map((s) => (
                <Row
                  key={`ask-${s.agentId}`}
                  color={agent(s.agentId)?.color}
                  text={
                    agent(s.agentId)?.crew?.session
                      ? `${agent(s.agentId)?.name ?? s.agentId} needs you. It's a background session you can't type to: answer through the coordinator`
                      : `${agent(s.agentId)?.name ?? s.agentId} is asking you something in its terminal`
                  }
                  onOpen={() => ui.openAgent(s.agentId, "terminal")}
                />
              ))}
              {a.access.map((r) => (
                <Row key={r.id} color={agent(r.agentId)?.color} text={`${agent(r.agentId)?.name ?? r.agentId} wants to reach ${r.domain}`} onOpen={() => ui.openAgent(r.agentId)} />
              ))}
              {a.blocked.map((b) => (
                <Row
                  key={`blk-${b.agentId}`}
                  color={agent(b.agentId)?.color}
                  text={`${agent(b.agentId)?.name ?? b.agentId}'s sandbox blocked ${b.count} request${b.count === 1 ? "" : "s"}`}
                  onOpen={() => ui.openAgent(b.agentId)}
                />
              ))}
              {a.readyPrs.map((p) =>
                p.url ? (
                  <li key={`pr-${p.number}`} className="flex items-center gap-2 border-[3px] border-line bg-card px-2.5 py-1.5">
                    <span className="flex-1">
                      PR <b>#{p.number}</b> {p.title} passed review and is ready to merge
                    </span>
                    <a className="btn px-2 text-[12px]" href={p.url} target="_blank" rel="noreferrer">
                      Open ↗
                    </a>
                  </li>
                ) : (
                  <Row key={`pr-${p.number}`} text={`PR #${p.number} ${p.title} passed review and is ready to merge`} onOpen={() => ui.openPrs()} />
                ),
              )}
            </ul>
          </>
        )}

        {closed.length > 0 && (
          <>
            <button className="text-[13px] underline" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? "Hide closed" : `Show closed (${closed.length})`}
            </button>
            {showClosed && (
              <ul className="mt-2 flex flex-col gap-1 text-[13px] text-muted">
                {closed.map((i) => (
                  <li key={i.id} className="border-t-2 border-dashed border-cream-3 py-1">
                    <span className={i.status === "dismissed" ? "line-through" : ""}>{i.title}</span> · {agent(i.fromId)?.name ?? i.fromId} ·{" "}
                    {i.request ? (i.answer?.state === "recorded" ? "answered here, recorded by Pathfinder" : "resolved in Pathfinder") : i.status} {i.closedAt ? `${ago(i.closedAt, now)} ago` : ""}
                    {i.answer?.state === "recorded" && <div className="pl-3">Your answer: “{i.answer.text}”</div>}
                    {i.note && <div className="pl-3">{i.request ? i.note : `“${i.note}”`}</div>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Row({ text, color, onOpen }: { text: string; color?: string; onOpen: () => void }) {
  return (
    <li className="flex items-center gap-2 border-[3px] border-line bg-card px-2.5 py-1.5">
      {color && <Dot color={color} size={8} />}
      <span className="flex-1">{text}</span>
      <button className="btn px-2 text-[12px]" onClick={onOpen}>
        Open
      </button>
    </li>
  );
}

function Item({ item, from, now, snap }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number; snap: OfficeSnapshot }) {
  // Keyed by kind as well, so a request never reuses an agent item's hooks. A gate keeps its card (and an answer
  // being typed) while its ticket and question stay the same, as when Pathfinder gives it its occurrence a moment
  // after it appears; what is sent always names the request shown at that moment.
  return item.request ? <GateRequest key={`gate:${item.request.key}:${item.details}`} item={item} now={now} snap={snap} /> : <AgentItem item={item} from={from} now={now} />;
}

function AgentItem({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const long = item.details.split("\n").length > 6 || item.details.length > 400;
  return (
    <li className={`border-[3px] border-line bg-card px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)] ${item.waiting ? "outline outline-[3px] outline-[#ff4f7b]" : ""}`}>
      <div className="flex items-start gap-2">
        <b className="flex-1 text-[15px]">{item.title}</b>
        {item.waiting && <span className="chip shrink-0 text-[11px]" style={{ background: "#ff4f7b" }}>◆ waiting</span>}
      </div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
        {from && <Dot color={from.color} size={8} />}
        <button className="underline" onClick={() => from && ui.openAgent(from.id, "messages")}>
          {from?.name ?? item.fromId}
        </button>
        {item.taskId && <span>· {item.taskId}</span>}
        <span>· {ago(item.at, now)} ago</span>
      </div>
      {item.details && (
        <div className={`whitespace-pre-wrap text-[13px] ${long && !expanded ? "line-clamp-6" : ""}`}>{item.details}</div>
      )}
      {long && (
        <button className="text-[12px] underline" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-[13px]"
          value={note}
          placeholder="Note for the agent (optional, no secrets)"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && officeActions.resolveActionItem(item.id, "done", note)}
        />
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "done", note)}>
          Done
        </button>
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed", note)}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

const ANSWER_WORDS: Record<NonNullable<ActionItem["answer"]>["state"], string> = {
  sending: "Sending…",
  delivered: "Delivered to the coordinator · waiting for Pathfinder to record it",
  recorded: "Recorded by Pathfinder",
  failed: "Not delivered",
  rejected: "Not sent",
};

/**
 * A Pathfinder human gate: what is asked, whose it is (ticket, stage, session, owner), an answer box that
 * sends exactly once through the coordinator, and how far the answer got. Snooze sends nothing.
 */
function GateRequest({ item, now, snap }: { item: ActionItem; now: number; snap: OfficeSnapshot }) {
  const r = item.request!;
  const [text, setText] = useState("");
  const owner = r.owner ? snap.config.team.find((a) => a.id === r.owner) : null;
  const a = item.answer && item.answer.revision === r.revision ? item.answer : null;
  const stale = item.answer && item.answer.revision !== r.revision ? item.answer : null;
  const [again, setAgain] = useState(false);
  // A gate with no occurrence can't show that a delivered answer was for the gate open now, so it can be answered again.
  const repeatable = !r.occurrence && a?.state === "delivered";
  const inFlight = (a?.state === "sending" || a?.state === "delivered" || a?.state === "recorded") && !(repeatable && again);
  const snoozed = item.snoozedUntil && Date.parse(item.snoozedUntil) > now;
  // What is typed belongs to one request. It is cleared once it is delivered, and when Pathfinder replaces this
  // occurrence with another (the same question raised again); a gate that only just got its occurrence keeps it.
  const shown = useRef(r);
  const deliveredAt = a?.state === "delivered" ? a.at : null;
  useEffect(() => {
    if (deliveredAt) setText("");
  }, [deliveredAt]);
  useEffect(() => {
    const replaced = shown.current.revision !== r.revision && !!shown.current.occurrence;
    shown.current = r;
    if (!replaced) return;
    setText("");
    setAgain(false);
  }, [r]);
  const send = () => {
    if (!text.trim() || inFlight) return;
    officeActions.resolveActionItem(item.id, "done", text, r.revision);
    setAgain(false);
  };
  return (
    <li className={`border-[3px] border-line bg-card px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)] ${!inFlight && !snoozed ? "outline outline-[3px] outline-[#ff4f7b]" : ""}`}>
      <div className="flex items-start gap-2">
        <b className="flex-1 text-[15px]">{r.key} needs your decision</b>
        {snoozed && <span className="chip shrink-0 text-[11px]">snoozed</span>}
      </div>
      <dl className="mb-1 grid grid-cols-[64px_1fr] gap-x-2 text-[12px] text-muted">
        <dt>Ticket</dt>
        <dd>{r.key}</dd>
        <dt>Stage</dt>
        <dd>{r.stage ?? "not recorded"}</dd>
        <dt>Session</dt>
        <dd>
          {owner ? (
            <button className="underline" onClick={() => ui.openAgent(owner.id)}>
              {owner.name} · {r.session}
            </button>
          ) : (
            <span className="text-[#c0392b]">Unable to identify session</span>
          )}
          {!owner && r.diagnostic && <div>{r.diagnostic}</div>}
        </dd>
        <dt>Request</dt>
        <dd>{r.occurrence ? `gate occurrence ${r.occurrence}` : "no occurrence ID in Pathfinder's record"}</dd>
        <dt>Raised</dt>
        <dd>{ago(item.at, now)} ago</dd>
      </dl>
      <div className="whitespace-pre-wrap text-[13px]">{item.details}</div>
      <p className="mt-1 text-[12px] text-muted">Your answer goes to the coordinator, which records it in Pathfinder for {r.key}. Background workers can't be typed to directly.</p>
      {a && (
        <div className={`mt-1 text-[12px] font-semibold ${a.state === "failed" || a.state === "rejected" ? "text-[#c0392b]" : "text-[#008751]"}`} role="status">
          {ANSWER_WORDS[a.state]}
          {a.detail && <span className="font-normal"> · {a.detail}</span>}
          {a.text && <div className="font-normal text-muted">“{a.text}”</div>}
        </div>
      )}
      {stale && <div className="mt-1 text-[12px] text-[#c0392b]">{stale.detail}</div>}
      {repeatable && !again && (
        <div className="mt-1 text-[12px] text-muted">
          This gate has no occurrence ID, so Tin & Thyme can't tell whether it was closed and raised again since you answered.{" "}
          <button className="underline" onClick={() => setAgain(true)}>
            Send another answer
          </button>
        </div>
      )}
      {!inFlight && (
        <div className="mt-2 flex items-end gap-2">
          <textarea
            className="field min-h-[38px] min-w-0 flex-1 text-[13px]"
            value={text}
            rows={2}
            placeholder={`Your answer for ${r.key} (no secrets)`}
            aria-label={`Answer for ${r.key}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && send()}
          />
          <button className="btn px-2 text-[12px]" disabled={!text.trim()} onClick={send}>
            Send answer
          </button>
          {!snoozed && (
            <button className="btn px-2 text-[12px]" title="Put it aside for an hour. Nothing is sent and the gate stays open." onClick={() => officeActions.resolveActionItem(item.id, "dismissed")}>
              Snooze 1 h
            </button>
          )}
        </div>
      )}
    </li>
  );
}
