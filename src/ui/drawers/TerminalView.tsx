import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { officeActions } from "../../store/office";
import { readTerminal, subscribeTerminal } from "../../store/terminal";
import { FONT_EVENT, savedFont, terminalFont, type FontStyle } from "../../theme/fonts";

const theme = {
  background: "#16213f",
  foreground: "#dfe6ff",
  cursor: "#dfe6ff",
  cursorAccent: "#16213f",
  selectionBackground: "#2c3b6b",
  black: "#241a2e",
  red: "#ff5c86",
  green: "#6cf08a",
  yellow: "#ffc14d",
  blue: "#29adff",
  magenta: "#ff77a8",
  cyan: "#3ee0d0",
  white: "#dfe6ff",
};

/** A link from a terminal, if it's a web link. A terminal's output is untrusted. */
function webLink(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Opens a link in a new tab. Called from a click, so pop-up blockers (Safari's especially) allow
 * it. If the browser blocks it anyway, copies the link instead and says so.
 */
function openOrCopy(href: string, say: (text: string) => void) {
  const tab = window.open(href, "_blank");
  if (tab) {
    tab.opener = null;
    return;
  }
  navigator.clipboard
    .writeText(href)
    .then(() => say("Your browser blocked the new tab. Link copied: paste it in a new tab."))
    .catch(() => say("Your browser blocked the new tab. Select the link and copy it."));
}

/** A real xterm.js terminal fed by the agent's (mock) output stream. */
export function TerminalView({ agentId, autoFocus = true }: { agentId: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const font = terminalFont(savedFont());
    // xterm activates links on mouseup, which Safari doesn't count as a click for opening tabs.
    // Remember the link there and open it on the click that follows.
    let pendingLink: string | null = null;
    const term = new Terminal({
      theme,
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      cursorBlink: true,
      scrollback: 3000,
      convertEol: false,
      allowProposedApi: false,
      // Links a program marks as links (OSC 8), e.g. with FORCE_HYPERLINK set: the full URL, however it wraps.
      linkHandler: { activate: (_e, uri) => (pendingLink = webLink(uri)), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Plain URLs in the output, including ones the terminal wrapped onto the next line.
    term.loadAddon(new WebLinksAddon((_e, uri) => (pendingLink = webLink(uri))));
    const onClick = () => {
      const href = pendingLink;
      pendingLink = null;
      if (href) openOrCopy(href, setNotice);
    };
    el.addEventListener("click", onClick, true);
    let unsub = () => {};
    let ro: ResizeObserver | null = null;

    // Font style changed in Settings: switch once the new font is loaded, then re-measure.
    const onFont = (e: Event) => {
      const f = terminalFont((e as CustomEvent<FontStyle>).detail);
      void document.fonts.load(f.load).finally(() => {
        if (disposed) return;
        term.options.fontFamily = f.family;
        term.options.fontSize = f.size;
        term.options.lineHeight = f.lineHeight;
        try {
          fit.fit();
        } catch {
          /* not open yet */
        }
      });
    };
    window.addEventListener(FONT_EVENT, onFont);

    // Measure with the font loaded, or columns come out wrong.
    void document.fonts.load(font.load).finally(() => {
      if (disposed) return;
      term.open(el);
      fit.fit();
      // The server sizes the agent's tmux window to this terminal and redraws it.
      officeActions.resizeTerminal(agentId, term.cols, term.rows);
      term.onResize(({ cols, rows }) => officeActions.resizeTerminal(agentId, cols, rows));
      term.write(readTerminal(agentId));
      unsub = subscribeTerminal(agentId, (data) => term.write(data));
      term.onData((data) => officeActions.sendTerminalInput(agentId, data));
      // Shift+Enter: xterm.js sends a plain Enter (\r), which submits. Send Alt+Enter (ESC \r)
      // instead, which Claude Code and Codex read as "new line".
      term.attachCustomKeyEventHandler((e) => {
        if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return true;
        if (e.type === "keydown") officeActions.sendTerminalInput(agentId, "\x1b\r");
        e.preventDefault();
        return false;
      });
      // Refit once the layout settles (drawer animation, a maximize, a note appearing), not on every
      // intermediate frame: each new size resizes the agent's tmux window, and the program in it redraws.
      let fitTimer = 0;
      ro = new ResizeObserver(() => {
        window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(() => {
          if (disposed) return;
          try {
            fit.fit();
          } catch {
            /* element hidden mid-animation */
          }
        }, 120);
      });
      ro.observe(el);
      if (autoFocus) term.focus();
    });

    return () => {
      disposed = true;
      window.removeEventListener(FONT_EVENT, onFont);
      el.removeEventListener("click", onClick, true);
      unsub();
      ro?.disconnect();
      term.dispose();
    };
  }, [agentId, autoFocus]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={host} className="h-full min-h-0 w-full bg-navy-2" />
      {notice && (
        <div role="status" className="absolute bottom-3 left-1/2 z-10 max-w-[90%] -translate-x-1/2 border-2 border-line bg-yellow px-2 py-1 text-[13px] text-[#141a2e]">
          {notice}
        </div>
      )}
    </div>
  );
}
