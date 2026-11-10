/**
 * After a full snapshot the server may still be filling in what it already knew (after a restart it
 * re-reads gates and finished workers a moment later). Changes in this window extend the baseline silently.
 */
export const SETTLE_MS = 3000;
