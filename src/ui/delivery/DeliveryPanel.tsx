// The delivery drawer's body: everything the human inspects, and the operations
// they run one by one. Presentational: it reads no store (DeliveryDrawer passes
// the view and the client), so tests render it directly.
//
// Every button is enabled or disabled by the same gate the server applies
// (src/data/delivery.ts gateOf), with the reason as its title. "No checks
// reported" is never shown as passing.

import { useState, type ReactNode } from "react";
import {
  DELIVERY_STEPS,
  gateOf,
  isReadyToDeliver,
  type DeliveryBoard,
  type DeliveryClient,
  type DeliveryOp,
  type DeliveryReply,
  type DeliveryStep,
  type DeliveryView,
  type StepView,
} from "../../data/delivery";

const RED = "#ff4f7b";
const AMBER = "#ffb35c";
const GREEN = "#00e436";

const STEP_LABEL: Record<DeliveryStep, string> = {
  inspect: "Inspect",
  approve: "Approve",
  push: "Push",
  ensurePr: "Pull request",
  status: "Checks & status",
  merge: "Merge",
  verify: "Verify",
};

const OP_LABEL: Record<DeliveryOp, string> = {
  inspect: "Inspect",
  approve: "Approve",
  acknowledgeNoChecks: "Acknowledge no checks",
  push: "Push",
  ensurePr: "Create or reuse PR",
  status: "Refresh status",
  merge: "Merge",
  verify: "Verify",
};

export interface DeliveryPanelProps {
  deliveryKey: string;
  board: DeliveryBoard | undefined;
  view: DeliveryView | undefined;
  /** Null on the demo/mock source: delivery needs the real kitchen. */
  client: DeliveryClient | null;
  /** Opens the in-app GitHub sign-in fix (kitchen only). */
  onSignIn?: () => void;
  /** Tests: a reply to show as the last result. */
  initialReply?: DeliveryReply | null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="mb-1.5 border-b-2 border-dashed border-cream-3 pb-0.5 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-all font-mono">{children}</span>
    </div>
  );
}

function Banner({ color, children, testId }: { color: string; children: ReactNode; testId?: string }) {
  return (
    <div className="mb-2 border-[3px] px-2.5 py-1.5 text-[13px]" style={{ borderColor: color }} data-testid={testId}>
      {children}
    </div>
  );
}

function StepRow({ name, step, running }: { name: DeliveryStep; step: StepView | undefined; running: boolean }) {
  const mark = running ? "…" : !step ? "—" : step.ok ? "✓" : "✗";
  const color = running ? AMBER : !step ? undefined : step.ok ? GREEN : RED;
  const state = running ? "running" : !step ? "not run" : step.ok ? "ok" : `failed${step.kind ? ` (${step.kind})` : ""}`;
  return (
    <li className="grid grid-cols-[18px_120px_1fr] gap-2 border-t-2 border-dashed border-cream-3 py-1 text-[13px]" data-step={name} data-state={state}>
      <span style={{ color }}>{mark}</span>
      <span className="font-semibold">{STEP_LABEL[name]}</span>
      <span className="min-w-0 break-words">
        <span className="text-muted">{state}</span>
        {step && <> · {step.message}</>}
        {step?.reasons && step.reasons.length > 0 && (
          <ul className="list-disc pl-4 text-muted">
            {step.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {step?.fix && <div className="text-muted">Fix: <code>{step.fix}</code></div>}
      </span>
    </li>
  );
}

export function DeliveryPanel({ deliveryKey, board, view, client, onSignIn, initialReply = null }: DeliveryPanelProps) {
  const [busy, setBusy] = useState<DeliveryOp | null>(null);
  const [last, setLast] = useState<DeliveryReply | null>(initialReply);
  const [ack, setAck] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);

  if (!client) return <p className="p-4 text-[14px] text-muted">Delivery needs the real kitchen. This demo has no repository to deliver.</p>;
  if (board && !board.available) return <p className="p-4 text-[14px] text-muted">Delivery is not available here: {board.reason}</p>;
  if (!view) return <p className="p-4 text-[14px] text-muted">The kitchen reports no delivery state for {deliveryKey}. It lists tickets the engine reports as done.</p>;

  const act = async (op: DeliveryOp, params: Record<string, string>) => {
    setBusy(op);
    setConfirmMerge(false);
    try {
      setLast(await client.request(op, { key: view.key, ...params }));
    } finally {
      setBusy(null);
    }
  };
  const button = (op: DeliveryOp, label: string, params: Record<string, string> = {}, extraBlock: string | null = null) => {
    const gate = gateOf(view, op);
    const why = busy ? `${OP_LABEL[busy]} is running` : extraBlock ?? gate?.message ?? null;
    return (
      <button className="btn px-2 text-[13px]" disabled={!!why} title={why ?? undefined} data-op={op} onClick={() => void act(op, params)}>
        {busy === op ? `${label}…` : label}
      </button>
    );
  };

  const i = view.inspection;
  const a = view.approval;
  const st = view.status;
  const runningStep = (view.running === "acknowledgeNoChecks" ? "approve" : view.running) as DeliveryStep | null;
  const stepOf = new Map(view.steps.map((s) => [s.step, s]));
  const noChecks = st?.checks.summary === "none";
  const evidence = i?.evidence;
  const ready = isReadyToDeliver(view);

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4" data-delivery={view.key}>
      {/* Readiness and outcome */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[14px]">
        {view.readiness.ready ? (
          <span className="chip text-[12px]" style={{ background: GREEN }} data-testid="readiness">
            {ready ? "Ready to deliver" : "Deliverable"}
          </span>
        ) : (
          <span className="chip text-[12px]" style={{ background: RED }} data-testid="readiness">
            Not deliverable
          </span>
        )}
        {!view.readiness.ready && <span className="text-muted">{view.readiness.reason}</span>}
        {view.running && <span className="text-muted">Running: {OP_LABEL[view.running]}…</span>}
      </div>

      {(view.outcome === "pending" || view.outcome === "unknown") && (
        <Banner color={AMBER} testId="outcome">
          <b>Outcome not confirmed — do not merge again.</b> {view.outcome === "pending" ? "The merge command succeeded but GitHub has not confirmed the merge yet." : "Whether the merge happened is unknown."}
          {view.pendingNote && <div className="text-muted">{view.pendingNote}</div>}
          <div className="mt-1">{button("verify", "Check outcome")}</div>
        </Banner>
      )}
      {view.outcome === "merged" && view.merged && (
        <Banner color={view.verified ? GREEN : RED} testId="outcome">
          <b>{view.verified ? "Merged · verified" : "Merged · verification failed (retry)"}</b> PR #{view.merged.pr}
          {view.merged.commit && <> as <code>{view.merged.commit}</code></>}
          {view.merged.verification && (
            <div className="text-muted">
              parent {view.merged.verification.parent.slice(0, 12)} · tree {view.merged.verification.tree.slice(0, 12)} · on main {view.merged.verification.main.slice(0, 12)}
            </div>
          )}
          {!view.verified && <div className="mt-1">{button("verify", "Verify again")}</div>}
        </Banner>
      )}
      {view.outcome === "not-merged" && view.lastAttempt && (
        <Banner color={RED} testId="outcome">
          <b>Not merged.</b> {view.lastAttempt.reason}
        </Banner>
      )}

      {last && !last.ok && (
        <Banner color={last.kind === "stale" || last.kind === "blocked" ? AMBER : RED} testId="last-error">
          <b>{OP_LABEL[last.op ?? "status"]} did not complete ({last.kind}).</b> {last.message}
          {last.reasons.length > 0 && (
            <ul className="list-disc pl-4">
              {last.reasons.map((r, n) => (
                <li key={n}>{r}</li>
              ))}
            </ul>
          )}
          {last.kind === "auth" && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {onSignIn && (
                <button className="btn px-2 text-[13px]" onClick={onSignIn}>
                  Sign in to GitHub
                </button>
              )}
              <span className="text-muted">
                or run <code>{last.fix ?? "gh auth login --web"}</code> in the kitchen's setup
              </span>
            </div>
          )}
        </Banner>
      )}

      <Section title="Target">
        <Row label="Repository">{view.repo ?? i?.repo ?? "—"}</Row>
        <Row label="Branch">{view.branch ?? view.readiness.branch ?? "—"}</Row>
        <Row label="Head">{view.head ?? "— (inspect)"}</Row>
        <Row label="Reviewed head">{i?.reviewedHead ?? view.readiness.reviewedHead ?? "—"}</Row>
        {i && i.recordOnly.length > 0 && <Row label="Record-only">{i.recordOnly.join(", ")} (change only {i.recordPath})</Row>}
        <Row label="Base (origin)">{view.base ?? "—"}</Row>
        {i && <Row label="Behind base">{i.behind ? `yes (merge base ${i.mergeBase})` : "no"}</Row>}
        <Row label="Merge tree">{view.tree ?? "—"}</Row>
        <div className="mt-2">{button("inspect", i ? "Inspect again" : "Inspect")}</div>
      </Section>

      <Section title="Changes">
        {i ? (
          <>
            <p className="text-[13px]" data-testid="diffstat">
              {i.stat.files} file{i.stat.files === 1 ? "" : "s"} · +{i.stat.added} −{i.stat.deleted}
            </p>
            <ul className="max-h-[220px] overflow-y-auto font-mono text-[12px]">
              {i.files.map((f) => (
                <li key={f.path} className="flex gap-2">
                  <span className="w-[90px] shrink-0 text-muted">{f.added === null ? "binary" : `+${f.added} −${f.deleted}`}</span>
                  <span className="break-all">{f.path}</span>
                </li>
              ))}
            </ul>
            {i.filesTruncated && <p className="text-[12px] text-muted">Only the first {i.files.length} files are listed.</p>}
            {i.unscanned.length > 0 && (
              <p className="text-[12px]" style={{ color: AMBER }}>
                Not scanned for secrets (binary): {i.unscanned.join(", ")}
              </p>
            )}
          </>
        ) : (
          <p className="text-[13px] text-muted">{view.head ? "Inspect again to see the diff (it is kept in memory only)." : "Inspect to see the diff."}</p>
        )}
      </Section>

      <Section title="Evidence">
        <Row label="Review">{evidence?.line ?? (view.readiness.reviewedHead ? `review PASS on ${view.readiness.reviewedHead}` : "—")}</Row>
        <div className="mt-1 text-[13px]" data-testid="local-evidence">
          <span className="text-muted">Local verification evidence: </span>
          {!i ? (
            <span className="text-muted">inspect to read it.</span>
          ) : evidence?.report ? (
            <>
              <span>{evidence.report.file}</span>
              <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap border-2 border-line bg-cream-2 p-2 text-[12px]">{evidence.report.text}</pre>
              {evidence.report.truncated && <span className="text-[12px] text-muted">(shortened)</span>}
            </>
          ) : (
            <span style={{ color: AMBER }}>no review report for this exact head was found in the kitchen's transfer folder; only the claim's review line above is recorded.</span>
          )}
        </div>
      </Section>

      <Section title="Approval">
        {view.approvalState === "stale" && (
          <Banner color={RED} testId="stale">
            <b>The approval is stale.</b> Push, PR and Merge are disabled.
            <ul className="list-disc pl-4">
              {view.staleReasons.map((r, n) => (
                <li key={n}>{r}</li>
              ))}
            </ul>
            <div className="mt-1">{button("inspect", "Inspect and approve again")}</div>
          </Banner>
        )}
        {a && view.approvalState === "valid" && (
          <div className="mb-2 text-[13px]" data-testid="approval">
            <b style={{ color: GREEN }}>Approved</b> {a.at && <span className="text-muted">at {a.at}</span>}
            <Row label="Head">{a.head}</Row>
            <Row label="Base">{a.base}</Row>
            <Row label="Tree">{a.tree}</Row>
            {a.acknowledgeNoChecks && <Row label="No checks">acknowledged on the local evidence</Row>}
          </div>
        )}
        {i && (
          <div className="flex flex-wrap items-center gap-2">
            {button("approve", "Approve this exact merge", { head: i.head, base: i.base, tree: i.tree })}
            <span className="text-[12px] text-muted">
              {i.head.slice(0, 12)} onto {i.base.slice(0, 12)} → tree {i.tree.slice(0, 12)}
            </span>
          </div>
        )}
      </Section>

      <Section title="Push and pull request">
        <div className="flex flex-wrap items-center gap-2">
          {button("push", a ? `Push ${a.head.slice(0, 12)}` : "Push", a ? { head: a.head } : {})}
          {button("ensurePr", "Create or reuse PR")}
          {view.pr && (
            <a className="btn px-2 text-[13px]" href={view.pr.url} target="_blank" rel="noreferrer">
              PR #{view.pr.number} ↗
            </a>
          )}
        </div>
      </Section>

      <Section title="Checks and mergeability">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
          {button("status", "Refresh status")}
          {st && <span className="text-muted">as of {st.at}</span>}
        </div>
        {st && (
          <div className="text-[13px]" data-testid="checks" data-summary={st.checks.summary}>
            {st.checks.summary === "none" ? (
              <b style={{ color: AMBER }}>No checks reported — this is not a pass.</b>
            ) : st.checks.summary === "passed" ? (
              <b style={{ color: GREEN }}>All reported checks passed</b>
            ) : st.checks.summary === "pending" ? (
              <b style={{ color: AMBER }}>Checks are still running — merging is blocked</b>
            ) : (
              <b style={{ color: RED }}>A check failed — merging is blocked</b>
            )}
            {st.checks.items.length > 0 && (
              <ul className="mt-1">
                {st.checks.items.map((c, n) => (
                  <li key={n}>
                    {c.link ? (
                      <a className="underline" href={c.link} target="_blank" rel="noreferrer">
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}{" "}
                    <span className="text-muted">· {c.bucket}</span>
                  </li>
                ))}
              </ul>
            )}
            <Row label="PR head">{st.head ?? "—"}</Row>
            <Row label="Mergeable">{st.mergeable ?? "—"}</Row>
            <Row label="Review decision">{st.reviewDecision ?? "none"}</Row>
          </div>
        )}
        {noChecks && a && view.approvalState === "valid" && !a.acknowledgeNoChecks && (
          <Banner color={AMBER} testId="ack">
            GitHub reports no checks for {a.head.slice(0, 12)}. Merging needs your acknowledgement of the local evidence shown above.
            <label className="mt-1 flex items-start gap-2">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I acknowledge that no checks ran on GitHub, and I merge this exact head on the local verification evidence.</span>
            </label>
            <div className="mt-1">{button("acknowledgeNoChecks", "Record acknowledgement", { head: a.head, base: a.base, tree: a.tree }, ack ? null : "Tick the acknowledgement first")}</div>
          </Banner>
        )}
      </Section>

      <Section title="Merge">
        {a ? (
          <div className="flex flex-wrap items-center gap-2">
            {confirmMerge ? (
              <>
                {button("merge", `Confirm: squash-merge ${a.head.slice(0, 12)}`, { head: a.head, base: a.base, tree: a.tree })}
                <button className="btn px-2 text-[13px]" onClick={() => setConfirmMerge(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="btn px-2 text-[13px]"
                data-op="merge"
                disabled={!!(busy || gateOf(view, "merge"))}
                title={gateOf(view, "merge")?.message}
                onClick={() => setConfirmMerge(true)}
              >
                Merge {a.head.slice(0, 12)} onto {a.base.slice(0, 12)}…
              </button>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-muted">Approve this exact merge first.</p>
        )}
        {(view.pr || view.outcome !== "none") && view.outcome !== "pending" && view.outcome !== "unknown" && <div className="mt-2">{button("verify", "Verify merge")}</div>}
      </Section>

      <Section title="Steps">
        <ul data-testid="steps">
          {DELIVERY_STEPS.map((n) => (
            <StepRow key={n} name={n} step={stepOf.get(n)} running={runningStep === n} />
          ))}
        </ul>
      </Section>
    </div>
  );
}
