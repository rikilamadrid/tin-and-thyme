// The delivery drawer's body: everything the human inspects, and the operations
// they run one by one. Presentational: it reads no store (DeliveryDrawer passes
// the view and the client), so tests render it directly.
//
// Every button is enabled or disabled by the same gate the server applies
// (src/data/delivery.ts gateOf), with the reason as its title. "No checks
// reported" is never shown as passing.
//
// After a verified merge: reconcile main, hand the ticket back (the coordinator
// releases its claim), then the ticket's completion records are prepared and
// delivered as their own records PR: the same panel, nested, for the records
// view, with every request sent as `track: "records"`.

import { useState, type ReactNode } from "react";
import {
  DELIVERY_STEPS,
  gateOf,
  isReadyToDeliver,
  recordsSettled,
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
  reconcile: "Reconcile main",
  records: "Completion records",
  handback: "Hand back",
  plan: "Plan",
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
  reconcilePlan: "List main checkout",
  reconcile: "Reconcile main",
  prepareRecords: "Prepare completion records",
  handback: "Hand back to the coordinator",
  plan: "Refresh plan",
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
  /** Rendered inside the ticket's panel (the completion-records delivery). */
  nested?: boolean;
}

/** The client for the records delivery: the same requests, for `track: "records"`. */
export const recordsClientOf = (client: DeliveryClient): DeliveryClient => ({ request: (op, params) => client.request(op, { ...params, track: "records" }) });

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

export function DeliveryPanel({ deliveryKey, board, view, client, onSignIn, initialReply = null, nested = false }: DeliveryPanelProps) {
  const [busy, setBusy] = useState<DeliveryOp | null>(null);
  const [last, setLast] = useState<DeliveryReply | null>(initialReply);
  const [ack, setAck] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmReconcile, setConfirmReconcile] = useState(false);

  if (!client) return <p className="p-4 text-[14px] text-muted">Delivery needs the real kitchen. This demo has no repository to deliver.</p>;
  if (board && !board.available) return <p className="p-4 text-[14px] text-muted">Delivery is not available here: {board.reason}</p>;
  if (!view) return <p className="p-4 text-[14px] text-muted">The kitchen reports no delivery state for {deliveryKey}. It lists tickets the engine reports as done.</p>;

  const act = async (op: DeliveryOp, params: Record<string, string>) => {
    setBusy(op);
    setConfirmMerge(false);
    setConfirmReconcile(false);
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
  const recordsTrack = view.track === "records";
  const steps = recordsTrack ? DELIVERY_STEPS.filter((n) => n !== "records" && n !== "handback" && n !== "plan") : DELIVERY_STEPS;
  const recordsPanel =
    !recordsTrack && view.records ? (
      <DeliveryPanel deliveryKey={view.key} board={board} view={view.records} client={recordsClientOf(client)} onSignIn={onSignIn} nested />
    ) : null;

  return (
    <div className={nested ? "border-[3px] border-dashed border-cream-3 p-3" : "scroll-thin min-h-0 flex-1 overflow-y-auto p-4"} data-delivery={view.key} data-track={view.track}>
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
        {recordsTrack ? (
          <Row label="Records head">{view.readiness.reviewedHead ?? "— (prepare the records)"}</Row>
        ) : (
          <Row label="Reviewed head">{i?.reviewedHead ?? view.readiness.reviewedHead ?? "—"}</Row>
        )}
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

      {recordsTrack ? (
        <Section title="Records check">
          <div className="text-[13px]" data-testid="records-check">
            {i?.evidence.line ? <span>{i.evidence.line}</span> : <span className="text-muted">Inspect to run the mechanical records check.</span>}
            <p className="mt-1 text-muted">
              Only a records-only diff passes: the ticket's Status, the derived Feature Status and the history entry, exactly. Your exact approval of this head accepts it in place of a tester PASS; any
              other change is refused and needs normal review.
            </p>
          </div>
        </Section>
      ) : (
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
      )}

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

      {view.outcome === "merged" && <AfterMerge view={view} button={button} busy={busy} confirm={confirmReconcile} setConfirm={setConfirmReconcile} records={recordsPanel} />}

      <Section title="Steps">
        <ul data-testid="steps">
          {steps.map((n) => (
            <StepRow key={n} name={n} step={stepOf.get(n)} running={runningStep === n} />
          ))}
        </ul>
      </Section>
    </div>
  );
}

type ButtonFn = (op: DeliveryOp, label: string, params?: Record<string, string>, extraBlock?: string | null) => ReactNode;

/**
 * After a verified merge, in order: list the main checkout and reconcile it for
 * exactly that listing, hand the ticket back to the coordinator once, deliver
 * the completion records (the ticket's panel only), refresh the plan.
 */
function AfterMerge({
  view,
  button,
  busy,
  confirm,
  setConfirm,
  records,
}: {
  view: DeliveryView;
  button: ButtonFn;
  busy: DeliveryOp | null;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  records: ReactNode;
}) {
  const am = view.after;
  const rp = am.reconcilePlan;
  const done = am.reconciled;
  const hb = am.handback;
  const plan = am.plan;
  const reconcileGate = gateOf(view, "reconcile");
  return (
    <Section title="After merge">
      <Row label="Local main">
        <span data-testid="main-has-merge" data-value={String(am.mainHasMerge)}>
          {am.mainHasMerge === true ? "contains the merge" : am.mainHasMerge === false ? "does not contain the merge yet" : "—"}
        </span>
      </Row>

      <div className="mt-2 flex flex-wrap items-center gap-2">{button("reconcilePlan", rp ? "List the main checkout again" : "List the main checkout")}</div>
      {rp && (
        <div className="mt-2 text-[13px]" data-testid="reconcile-plan" data-collisions={rp.collisions.length}>
          <div className="text-muted">
            as of {rp.at}: {rp.branch} {rp.head.slice(0, 12)} → origin/{rp.branch} {rp.target.slice(0, 12)}
          </div>
          {rp.refusal ? (
            <Banner color={RED} testId="reconcile-refusal">
              <b>Cannot reconcile.</b> {rp.refusal}
            </Banner>
          ) : rp.upToDate ? (
            <p>Local main already contains the merge: nothing to move or fast-forward.</p>
          ) : (
            <>
              {rp.collisions.length ? (
                <>
                  <p>
                    These {rp.collisions.length} file{rp.collisions.length === 1 ? "" : "s"} would be overwritten or removed. Each is copied to a new backup folder with a manifest, the copy is checked byte for
                    byte, and only then is it moved out of the way. Nothing is deleted.
                  </p>
                  <ul className="mt-1 font-mono text-[12px]" data-testid="collisions">
                    {rp.collisions.map((c) => (
                      <li key={c.path} className="border-t-2 border-dashed border-cream-3 py-0.5" data-path={c.path}>
                        <span className="break-all">{c.path}</span>{" "}
                        <span className="text-muted">
                          · {c.kind} ({c.status}) · {c.why}
                          {c.type === "missing" ? " · deleted here" : ""}
                          {c.staged ? " · staged content saved too" : ""}
                        </span>{" "}
                        {c.sameAsMerged ? <span style={{ color: GREEN }}>same as merged</span> : <span style={{ color: AMBER }}>differs from merged</span>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>Nothing collides: main fast-forwards as it is.</p>
              )}
              <p className="mt-1 text-muted">
                {rp.preservedTotal} unrelated change{rp.preservedTotal === 1 ? "" : "s"} stay{rp.preservedTotal === 1 ? "s" : ""} exactly where {rp.preservedTotal === 1 ? "it is" : "they are"}
                {rp.preserved.length ? `: ${rp.preserved.slice(0, 12).map((p) => p.path).join(", ")}${rp.preservedTotal > 12 ? ", …" : ""}` : ""}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {confirm ? (
                  <>
                    {button("reconcile", `Confirm: back up ${rp.collisions.length} and fast-forward ${rp.branch}`, { digest: rp.digest })}
                    <button className="btn px-2 text-[13px]" onClick={() => setConfirm(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="btn px-2 text-[13px]" data-op="reconcile" disabled={!!(busy || reconcileGate)} title={reconcileGate?.message} onClick={() => setConfirm(true)}>
                    Back up {rp.collisions.length} file{rp.collisions.length === 1 ? "" : "s"} and fast-forward {rp.branch}…
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {done && (
        <div className="mt-2 text-[13px]" data-testid="reconciled">
          <b style={{ color: GREEN }}>Main reconciled</b> <span className="text-muted">at {done.at}</span>
          <Row label="Fast-forward">
            {done.before.slice(0, 12)} → {done.after.slice(0, 12)}
          </Row>
          <Row label="Backup">{done.backup ? `${done.backup} (${done.moved} file${done.moved === 1 ? "" : "s"}, manifest.json)` : "nothing was moved"}</Row>
          <Row label="Kept">{`${done.preserved} unrelated change${done.preserved === 1 ? "" : "s"}`}</Row>
        </div>
      )}

      {view.track === "ticket" && (
      <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {button("handback", hb?.status === "unconfirmed" ? "Send the handback again" : "Hand back to the coordinator")}
        <span className="text-[12px] text-muted">asks it once to run /ticket complete {view.key}, then orchestrate release {view.key}</span>
      </div>
      {hb && (
        <div className="mt-1 text-[13px]" data-testid="handback" data-status={hb.status}>
          <b style={{ color: hb.status === "sent" ? GREEN : AMBER }}>{hb.status === "sent" ? "Handed back" : hb.status === "sending" ? "Sending…" : "Not confirmed"}</b>{" "}
          <span className="text-muted">
            at {hb.at} · {hb.note}
          </span>
          <div className="font-mono text-[12px] text-muted">{hb.marker}</div>
        </div>
      )}
      <Row label="Claim">
        <span data-testid="claim-released" data-value={String(am.claimReleased)}>
          {am.claimReleased === true ? "released" : am.claimReleased === false ? "still held (the coordinator releases it after the handback)" : "—"}
        </span>
      </Row>

      <CompletionRecords view={view} button={button} records={records} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {button("plan", "Refresh the plan")}
        {plan && <span className="text-[12px] text-muted">as of {plan.at}</span>}
      </div>
      {plan && (
        <div className="mt-1 text-[13px]" data-testid="plan">
          <p className="text-muted">{plan.message}</p>
          {plan.eligible.length > 0 ? (
            <ul>
              {plan.eligible.map((e) => (
                <li key={e.key} data-key={e.key} data-newly={plan.newly.includes(e.key) ? "yes" : "no"}>
                  <b>{e.key}</b> {e.title}
                  {plan.newly.includes(e.key) && (
                    <span className="chip ml-1 text-[11px]" style={{ background: GREEN }}>
                      newly eligible
                    </span>
                  )}
                  {e.deferred && <span className="text-muted"> · {e.deferred}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p>No ticket is eligible now.</p>
          )}
          {plan.waitingOn.length > 0 && (
            <p className="text-muted">
              Still waiting on {view.key}: {plan.waitingOn.map((w) => w.key).join(", ")} (its completion has not reached the ticket store yet)
            </p>
          )}
        </div>
      )}
      </>
      )}
    </Section>
  );
}

/**
 * The completion records: prepared from the updated main once the claim is
 * released, then delivered as their own records PR from ticket/<key>-records
 * (the nested panel).
 */
function CompletionRecords({ view, button, records }: { view: DeliveryView; button: ButtonFn; records: ReactNode }) {
  const p = view.recordsPrep;
  const settled = recordsSettled(view);
  return (
    <div className="mt-3" data-testid="completion-records" data-settled={settled ? "no" : "yes"}>
      <h5 className="text-[13px] font-semibold">Completion records</h5>
      <p className="text-[12px] text-muted">
        The ticket's Status, the derived Feature Status and, when the Feature completes, one history entry — committed from the updated main once the claim is released, and delivered as a records PR
        from ticket/{view.key}-records, never left on main uncommitted.
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">{button("prepareRecords", p?.head ? "Prepare again" : "Prepare completion records")}</div>
      {p && (
        <div className="mt-1 text-[13px]" data-testid="records-prep" data-on-main={String(p.onMain)}>
          {p.onMain ? (
            <span>Local main already records {view.key} Complete: there are no records to deliver.</span>
          ) : (
            <>
              <Row label="Branch (origin)">{p.branch}</Row>
              <Row label="Records head">{p.head}</Row>
              <Row label="Kept locally as">{p.ref} (not a local branch)</Row>
              <Row label="Cut from">{p.parent}</Row>
              <ul className="list-disc pl-4 text-[12px]">
                {p.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {records}
      <p className="mt-1 text-[12px]" style={{ color: settled ? AMBER : GREEN }}>
        {settled ?? "The completion records are on local main."}
      </p>
    </div>
  );
}
