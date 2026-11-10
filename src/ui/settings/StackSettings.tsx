import { useState } from "react";
import {
  EMPTY_STACK,
  frameworks,
  STACK_CATEGORIES,
  stackDomains,
  stackKeys,
  stackRoleMd,
  stackTool,
  toolsIn,
  type StackCategory,
  type StackChoice,
  type StackConfig,
} from "../../data/stack";
import { officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Field, SectionTitle } from "../kit";
import { CommitInput } from "./controls";

/** Optional: what the project is built with. Agents get it in ROLE.md, plus skills and access. */
export function StackSettings() {
  const stack = useOffice((s) => s.snap?.config.stack) ?? EMPTY_STACK;
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const save = (next: StackConfig) => {
    const empty = !next.frameworks.length && !Object.values(next.tools).some(Boolean);
    officeActions.updateStack(empty ? null : next);
  };
  const empty = !stack.frameworks.length && !Object.values(stack.tools).some(Boolean);

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[14px] text-muted">
        Optional. Tell the agents what this project is built with: they'll get it in their ROLE.md, the tools' agent skills, and access to their docs once you allow it.
        Skip it and agents work as before.
      </p>

      <Frameworks stack={stack} save={save} />

      <section>
        <SectionTitle>Tools</SectionTitle>
        <div className="flex flex-col gap-2">
          {STACK_CATEGORIES.map((c) => (
            <ToolRow key={c.id} category={c.id} label={c.label} hint={c.hint} stack={stack} save={save} />
          ))}
        </div>
      </section>

      {!empty && (
        <>
          <Access stack={stack} sandboxed={team.filter((a) => a.mode === "sandbox").map((a) => a.id)} />
          <Keys stack={stack} />
          <section>
            <SectionTitle>What agents read</SectionTitle>
            <p className="mb-2 text-[13px] text-muted">Added to every agent's ROLE.md the next time it starts.</p>
            <pre className="m-0 whitespace-pre-wrap border-[3px] border-line bg-navy-2 p-3 font-term text-[16px] leading-tight text-[#dfe6ff]">{stackRoleMd(stack)}</pre>
          </section>
          <div>
            <button className="btn text-[13px]" onClick={() => officeActions.updateStack(null)}>
              Clear stack
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Frameworks({ stack, save }: { stack: StackConfig; save: (s: StackConfig) => void }) {
  const chosen = (id: string) => stack.frameworks.some((f) => f.id === id);
  const toggle = (id: string) =>
    save({ ...stack, frameworks: chosen(id) ? stack.frameworks.filter((f) => f.id !== id) : [...stack.frameworks, { id }] });
  const patch = (i: number, p: Partial<StackChoice>) => save({ ...stack, frameworks: stack.frameworks.map((f, j) => (j === i ? { ...f, ...p } : f)) });

  return (
    <section>
      <SectionTitle>Frameworks</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">Pick one or more, e.g. Next.js for the app and Express for an API.</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[...frameworks(), { id: "other", name: "Other" }].map((f) => (
          <button key={f.id} className="btn px-2 py-0.5 text-[13px]" aria-pressed={chosen(f.id)} onClick={() => toggle(f.id)}>
            {f.name}
          </button>
        ))}
      </div>
      {stack.frameworks.length > 0 && (
        <div className="flex flex-col gap-2">
          {stack.frameworks.map((f, i) => (
            <div key={f.id} className="grid grid-cols-[150px_1fr_1fr] items-end gap-2 border-[3px] border-line bg-card px-3 py-2">
              <b className="pb-2 text-[15px]">{f.id === "other" ? "Other" : stackTool(f.id)?.name}</b>
              {f.id === "other" ? (
                <Field label="Name">
                  <CommitInput className="field" value={f.name ?? ""} placeholder="Remix" onCommit={(v) => patch(i, { name: v.trim() || undefined })} />
                </Field>
              ) : (
                <Skills id={f.id} />
              )}
              <Field label="Where (optional)">
                <CommitInput className="field font-term text-[17px]" value={f.where ?? ""} placeholder={i === 0 ? "apps/web" : "apps/api"} onCommit={(v) => patch(i, { where: v.trim() || undefined })} />
              </Field>
              {f.id === "other" && (
                <div className="col-span-3">
                  <Field label="Docs URL">
                    <CommitInput className="field font-term text-[17px]" value={f.docsUrl ?? ""} placeholder="https://remix.run/docs" onCommit={(v) => patch(i, { docsUrl: v.trim() || undefined })} />
                  </Field>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolRow({ category, label, hint, stack, save }: { category: StackCategory; label: string; hint: string; stack: StackConfig; save: (s: StackConfig) => void }) {
  const choice = stack.tools[category];
  const set = (c: StackChoice | undefined) => {
    const tools = { ...stack.tools };
    if (c) tools[category] = c;
    else delete tools[category];
    save({ ...stack, tools });
  };
  return (
    <div className="grid grid-cols-[150px_220px_1fr] items-center gap-3 border-[3px] border-line bg-card px-3 py-2">
      <div>
        <b className="text-[15px]">{label}</b>
        <div className="text-[12px] text-muted">{hint}</div>
      </div>
      <select className="field" value={choice?.id ?? ""} aria-label={label} onChange={(e) => set(e.target.value ? { id: e.target.value } : undefined)}>
        <option value="">None</option>
        {toolsIn(category).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        <option value="other">Other…</option>
      </select>
      {choice?.id === "other" ? (
        <div className="grid grid-cols-2 gap-2">
          <CommitInput className="field" value={choice.name ?? ""} placeholder="Tool name" onCommit={(v) => set({ ...choice, name: v.trim() || undefined })} />
          <CommitInput className="field font-term text-[17px]" value={choice.docsUrl ?? ""} placeholder="Docs URL" onCommit={(v) => set({ ...choice, docsUrl: v.trim() || undefined })} />
        </div>
      ) : choice ? (
        <Skills id={choice.id} />
      ) : (
        <span className="text-[13px] text-muted">Not set</span>
      )}
    </div>
  );
}

/** What choosing this tool brings: skills and MCP. */
function Skills({ id }: { id: string }) {
  const t = stackTool(id);
  if (!t) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-1 text-[12px]">
      {t.skills.length ? (
        t.skills.map((s) => (
          <span key={s.source} className="chip font-term text-[14px]" title={s.skills.join(", ")}>
            {s.skills.length} skill{s.skills.length === 1 ? "" : "s"} · {s.source}
          </span>
        ))
      ) : (
        <span className="text-muted">No agent skills listed</span>
      )}
      {t.mcp && (
        <span className="chip font-term text-[14px]" title={t.mcp}>
          MCP
        </span>
      )}
    </div>
  );
}

/** The stack's docs/API domains: allow them for every sandboxed agent, after you confirm. */
function Access({ stack, sandboxed }: { stack: StackConfig; sandboxed: string[] }) {
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const domains = stackDomains(stack);
  const allowedForAll = (d: string) => sandboxed.length > 0 && sandboxed.every((id) => team.find((a) => a.id === id)?.sandbox.allow.includes(d));
  const missing = domains.filter((d) => !allowedForAll(d.domain)).map((d) => d.domain);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const selected = picked ?? new Set(missing);

  const allow = () => {
    for (const id of sandboxed) {
      const a = team.find((x) => x.id === id);
      if (!a) continue;
      const next = [...new Set([...a.sandbox.allow, ...selected])];
      if (next.length !== a.sandbox.allow.length) officeActions.updateSandbox(id, { allow: next });
    }
    setPicked(null);
  };

  return (
    <section>
      <SectionTitle>Network access</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">
        Sandboxes block most docs sites and APIs. Allow these for every sandboxed agent, or leave them: an agent that needs a site asks you first (<i>request_access</i>).
      </p>
      <div className="border-[3px] border-line bg-card">
        {domains.map((d) => {
          const done = allowedForAll(d.domain);
          return (
            <label key={d.domain} className="flex items-center gap-2.5 border-t-2 border-dashed border-cream-3 px-3 py-1.5 first:border-t-0">
              <input
                type="checkbox"
                disabled={done}
                checked={done || selected.has(d.domain)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(d.domain);
                  else next.delete(d.domain);
                  setPicked(next);
                }}
              />
              <span className="font-term text-[17px]">{d.domain}</span>
              <span className="text-[12px] text-muted">{d.for.join(", ")}</span>
              {done && <span className="ml-auto text-[12px] font-semibold" style={{ color: "#4fe07a" }}>allowed</span>}
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button className="btn text-[13px]" disabled={!sandboxed.length || ![...selected].some((d) => missing.includes(d))} onClick={allow}>
          Allow selected for {sandboxed.length} sandboxed agent{sandboxed.length === 1 ? "" : "s"}
        </button>
        <button className="text-[13px] underline" onClick={() => ui.openSettings("sandbox")}>
          Per-agent rules
        </button>
      </div>
    </section>
  );
}

function Keys({ stack }: { stack: StackConfig }) {
  const keys = stackKeys(stack);
  if (!keys.length) return null;
  return (
    <section>
      <SectionTitle>Keys the app needs</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">
        Put test keys in each agent's env file (Settings → Sandbox → Env file). HQ never asks for, stores or reads the values.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((k) => (
          <span key={k.key} className="chip font-term text-[15px]" title={k.for}>
            {k.key}
          </span>
        ))}
      </div>
    </section>
  );
}
