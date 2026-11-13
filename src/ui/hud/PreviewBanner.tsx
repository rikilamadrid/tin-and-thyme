import { useOffice } from "../../store/office";

/** Shown only by a preview server: which reviewed build this page is, and that it holds no sessions. */
export function PreviewBanner() {
  const preview = useOffice((s) => s.snap?.preview);
  if (!preview) return null;
  const built = new Date(preview.builtAt);
  const when = Number.isNaN(built.getTime()) ? preview.builtAt : built.toLocaleString();
  return (
    <div
      role="status"
      data-testid="preview-build"
      title={`Preview of ${preview.repo} (${preview.repoKey})\ncommit ${preview.sha}\ntree ${preview.tree}\nbuilt ${preview.builtAt}`}
      className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 border-[3px] border-line bg-card px-3 py-1 font-mono text-[13px] text-yellow shadow-[0_3px_0_rgba(36,26,46,0.45)]"
    >
      PREVIEW · commit {preview.sha.slice(0, 12)} · tree {preview.tree.slice(0, 12)} · built {when} · delivery only, no agent sessions
    </div>
  );
}
