/** Derived from the connected repository and this session's own transcript; never editable configuration. */
export interface RoleContract {
  role: string;
  session: string | null;
  source: string | null;
  origin: "worktree" | "checkout" | "checkout-fallback";
  text: string | null;
  hash: string | null;
  error: string | null;
  agentType: string | null;
  definition: string | null;
  conflict: string | null;
  evidence: {
    transcript: string;
    line: number;
    toolId: string;
    tool: "Read" | "Bash";
    source: string;
    hash: string;
  } | null;
}
