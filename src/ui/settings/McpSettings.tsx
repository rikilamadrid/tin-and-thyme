import { useState } from "react";
import { chosenTools, STACK_CATALOG } from "../../data/stack";
import { officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { TerminalView } from "../drawers/TerminalView";

const STATUS: Record<string, [string, string]> = {
  ready: ["Ready", "#00e436"],
  "needs-auth": ["Needs sign-in", "#ffa300"],
};

/** MCP servers from Docker Sandboxes' registry, and which agents get them. */
export function McpSettings() {
  const mcp = useOffice((s) => s.snap?.mcp);
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const stack = useOffice((s) => s.snap?.config.stack);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", url: "", apiKey: "", command: "", args: "", local: false });
  if (!mcp) return <p className="text-[14px] text-muted">Loading MCP servers…</p>;

  const servers = mcp.servers;
  const sandboxed = team.filter((a) => a.mode === "sandbox");
  const suggestions = chosenTools(stack).filter((t) => t.mcp && !servers.some((s) => s.name === t.id));
  const toggle = (agentId: string, name: string, on: boolean) => {
    const cur = team.find((a) => a.id === agentId)?.mcp ?? [];
    officeActions.setAgentMcp(agentId, on ? [...cur, name] : cur.filter((n) => n !== name));
  };
  const stuck = team.flatMap((a) => (mcp.attached[a.id] ?? []).filter((n) => !(a.mcp ?? []).includes(n)).map((n) => ({ agent: a, name: n })));
  const tip = form.local ? null : missingParam(form.url);
  const canAdd = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(form.name.trim().toLowerCase()) && (form.local ? form.command.trim() : form.url.trim());
  const add = () => {
    officeActions.addMcp({
      name: form.name.trim().toLowerCase(),
      ...(form.local
        ? { command: form.command.trim(), args: form.args.trim() ? form.args.split(",").map((a) => a.trim()).filter(Boolean) : undefined }
        : { url: form.url.trim(), apiKey: form.apiKey.trim() || undefined }),
    });
    setForm({ name: "", url: "", apiKey: "", command: "", args: "", local: false });
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[14px] text-muted">
        MCP servers come from Docker Sandboxes' registry. Each one runs through sbx's gateway, so its sign-in or key never enters a sandbox. Tick a server
        for an agent and it's attached right away if the agent is running; agents don't need a restart.
      </p>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <SectionTitle>Servers</SectionTitle>
          <button className="btn px-2 text-[12px]" onClick={() => officeActions.refreshMcp()}>
            Refresh
          </button>
        </div>
        {mcp.error && <p className="mb-2 border-[3px] border-orange bg-warn px-3 py-1.5 text-[13px]">{mcp.error}</p>}
        {servers.length === 0 ? (
          <p className="text-[13px] text-muted">No MCP servers yet. Add one below.</p>
        ) : (
          <div className="border-[3px] border-line bg-card">
            {servers.map((s) => {
              const [label, color] = STATUS[s.status] ?? [s.status, "#83769c"];
              return (
                <div key={s.name} className="flex items-center gap-3 border-t-2 border-dashed border-cream-3 px-3 py-2 first:border-t-0">
                  <b className="font-term text-[17px]">{s.name}</b>
                  <span className="text-[12px] text-muted">{s.transport}</span>
                  <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: color }}>
                    {label}
                  </span>
                  <span className="flex-1" />
                  {s.status === "needs-auth" && (
                    <button
                      className="btn px-2 text-[12px]"
                      onClick={() => {
                        setSigningIn(s.name);
                        officeActions.authMcp(s.name);
                      }}
                    >
                      Sign in
                    </button>
                  )}
                  {deleting === s.name ? (
                    <>
                      <span className="text-[12px] text-[#ff7a9c]">Removes it from every sandbox on this Mac.</span>
                      <button
                        className="btn px-2 text-[12px]"
                        onClick={() => {
                          officeActions.removeMcp(s.name);
                          setDeleting(null);
                        }}
                      >
                        Delete
                      </button>
                      <button className="text-[12px] underline" onClick={() => setDeleting(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="text-[12px] underline" onClick={() => setDeleting(s.name)}>
                      Delete…
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {signingIn && (
          <div className="mt-2 border-[3px] border-line">
            <div className="flex items-center justify-between bg-navy px-2 py-1 text-[13px] text-ink">
              <span>Signing in to {signingIn} · your browser opens; answer here if it asks</span>
              <button className="text-[12px] underline" onClick={() => setSigningIn(null)}>
                Hide
              </button>
            </div>
            <div className="h-[200px]">
              <TerminalView key={signingIn} agentId={`setup:mcp-auth-${signingIn}`} />
            </div>
          </div>
        )}
      </section>

      {servers.length > 0 && (
        <section>
          <SectionTitle>Which agents get them</SectionTitle>
          {sandboxed.length === 0 ? (
            <p className="text-[13px] text-muted">MCP servers attach to sandboxes. All agents are in Local mode.</p>
          ) : (
            <table className="w-full border-[3px] border-line bg-card text-[14px]">
              <thead>
                <tr className="bg-cream-2 text-left">
                  <th className="px-3 py-1.5">Server</th>
                  {sandboxed.map((a) => (
                    <th key={a.id} className="px-3 py-1.5 text-center">
                      {a.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.name} className="border-t-2 border-dashed border-cream-3">
                    <td className="px-3 py-1.5 font-term text-[16px]">{s.name}</td>
                    {sandboxed.map((a) => {
                      const on = (a.mcp ?? []).includes(s.name);
                      const attached = (mcp.attached[a.id] ?? []).includes(s.name);
                      return (
                        <td key={a.id} className="px-3 py-1.5 text-center">
                          <input type="checkbox" checked={on} aria-label={`${s.name} for ${a.name}`} onChange={(e) => toggle(a.id, s.name, e.target.checked)} />
                          {on && !attached && <div className="text-[11px] text-muted">on next start</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {team.some((a) => a.mode === "local") && <p className="mt-1 text-[12px] text-muted">Local-mode agents aren't listed: MCP servers attach to sandboxes.</p>}
          {stuck.map(({ agent, name }) => (
            <p key={`${agent.id}-${name}`} className="mt-2 flex flex-wrap items-center gap-2 border-[3px] border-line bg-warn px-3 py-1.5 text-[13px]">
              <span className="flex-1">
                {agent.name}'s sandbox still has <b>{name}</b>: sbx can't detach a server, so it goes when the sandbox is recreated. The folder and code are
                kept; installed packages and the conversation are not.
              </span>
              <button
                className="btn px-2 text-[12px]"
                onClick={() => {
                  if (window.confirm(`Recreate ${agent.name}'s sandbox? Its folder is kept; the VM starts fresh.`)) officeActions.recreateSandbox(agent.id);
                }}
              >
                Recreate sandbox
              </button>
            </p>
          ))}
        </section>
      )}

      <section className="border-[3px] border-line bg-card p-3">
        <SectionTitle>Add a server</SectionTitle>
        {suggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="text-muted">From your stack:</span>
            {suggestions.map((t) => (
              <button key={t.id} className="btn px-2 text-[12px]" onClick={() => setForm({ ...form, local: false, name: t.id, url: t.mcp ?? "" })}>
                {t.name}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="Letters, numbers, - or _">
            <input className="field w-full font-term text-[17px]" value={form.name} placeholder="supabase" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {form.local ? (
            <Field label="Command" hint="A program on this Mac (local stdio server)">
              <input className="field w-full font-term text-[17px]" value={form.command} placeholder="npx" onChange={(e) => setForm({ ...form, command: e.target.value })} />
            </Field>
          ) : (
            <Field label="URL">
              <input className="field w-full font-term text-[17px]" value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </Field>
          )}
          {form.local ? (
            <Field label="Arguments" hint="Comma separated">
              <input className="field w-full font-term text-[17px]" value={form.args} placeholder="-y, @supabase/mcp-server" onChange={(e) => setForm({ ...form, args: e.target.value })} />
            </Field>
          ) : (
            <Field label="API key (optional)" hint="Sent as a Bearer token. Stored by Docker Sandboxes, never by HQ. Leave empty to sign in instead.">
              <input
                type="password"
                autoComplete="off"
                className="field w-full font-term text-[17px]"
                value={form.apiKey}
                placeholder="••••"
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </Field>
          )}
        </div>
        {tip && <p className="mt-2 text-[13px] text-muted">{tip}</p>}
        <div className="mt-3 flex items-center gap-3">
          <button className="btn" disabled={!canAdd} onClick={add}>
            Add server
          </button>
          <button className="text-[12px] underline" onClick={() => setForm({ ...form, local: !form.local })}>
            {form.local ? "Use a URL instead" : "Local server (command)…"}
          </button>
        </div>
      </section>
    </div>
  );
}

/** A stack tool's MCP URL without its suggested parameter (e.g. Supabase without project_ref): returns the tip. */
function missingParam(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const tool = STACK_CATALOG.find((t) => t.mcp && t.mcpParam && new URL(t.mcp).host === u.host);
  return tool?.mcpParam && !u.searchParams.get(tool.mcpParam.name)?.trim() ? tool.mcpParam.hint : null;
}
