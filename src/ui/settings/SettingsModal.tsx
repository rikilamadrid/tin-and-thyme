import { motion, useReducedMotion } from "framer-motion";
import { ui, useUi, type SettingsTab } from "../../store/ui";
import { AppearanceSettings } from "./AppearanceSettings";
import { AudioSettings } from "./AudioSettings";
import { ContextSettings } from "./ContextSettings";
import { BoardsSettings } from "./BoardsSettings";
import { ProjectSettings } from "./ProjectSettings";
import { SandboxSettingsTab } from "./SandboxSettings";
import { StackSettings } from "./StackSettings";
import { McpSettings } from "./McpSettings";
import { TeamSettings } from "./TeamSettings";
import { WorkflowSettings } from "./WorkflowSettings";

const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "appearance", label: "Appearance", hint: "Art style" },
  { id: "audio", label: "Audio", hint: "Sound effects" },
  { id: "context", label: "Context", hint: "Alert threshold" },
  { id: "team", label: "Team", hint: "Agents, roles, skills" },
  { id: "workflow", label: "Workflow", hint: "Review, merge, deploy" },
  { id: "stack", label: "Stack", hint: "Frameworks, tools" },
  { id: "mcp", label: "MCP", hint: "Servers for agents" },
  { id: "sandbox", label: "Sandbox", hint: "Network, proxy, secrets" },
  { id: "boards", label: "Boards", hint: "Progress boards" },
  { id: "project", label: "Project", hint: "Repo and HQ" },
];

export function SettingsModal() {
  const settings = useUi((s) => s.settings);
  const reduce = useReducedMotion();
  if (!settings) return null;

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}
    >
      <motion.div
        initial={reduce ? false : { y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="panel flex h-[min(760px,calc(100dvh-2rem))] w-[min(1080px,100%)] flex-col"
      >
        <div className="flex items-center gap-3 border-b-[3px] border-line px-4 py-2">
          <h2 className="m-0 flex-1 text-[22px] font-bold">Settings</h2>
          <span className="text-[13px] text-muted">Changes apply right away.</span>
          <button className="btn px-2.5" aria-label="Close settings" onClick={() => ui.closeSettings()}>
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[200px] shrink-0 flex-col gap-2 border-r-[3px] border-line bg-cream-2 p-3" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="btn block px-2.5 py-1 text-left"
                aria-pressed={settings.tab === t.id}
                onClick={() => ui.openSettings(t.id, settings.agentId)}
              >
                <div className="text-[16px]">{t.label}</div>
                <div className="text-[11px] font-normal text-muted">{t.hint}</div>
              </button>
            ))}
          </nav>
          <div className="scroll-thin min-w-0 flex-1 overflow-y-auto p-5">
            {settings.tab === "appearance" && <AppearanceSettings />}
            {settings.tab === "audio" && <AudioSettings />}
            {settings.tab === "context" && <ContextSettings />}
            {settings.tab === "team" && <TeamSettings />}
            {settings.tab === "workflow" && <WorkflowSettings />}
            {settings.tab === "stack" && <StackSettings />}
            {settings.tab === "mcp" && <McpSettings />}
            {settings.tab === "sandbox" && <SandboxSettingsTab initialAgentId={settings.agentId} />}
            {settings.tab === "boards" && <BoardsSettings />}
            {settings.tab === "project" && <ProjectSettings />}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
