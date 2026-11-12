// The seam between in-app delivery and 10.4's preview server
// (server/preview/server.ts, not in this branch). When the reviewed stack is
// combined, the preview attaches delivery with these few lines, and nothing else:
//
//   import { attachDelivery, PREVIEW_COMMANDS_NONE } from "../delivery/preview";
//   export const PREVIEW_COMMANDS = PREVIEW_COMMANDS_NONE;          // stays empty
//   const delivery = attachDelivery({ hub, root: repo.root, github: repo.github, kitchenKey: repoKey });
//   … startHttp({ …, commands: PREVIEW_COMMANDS, rpc: delivery.rpc });
//   delivery.start();                       // after startHttp
//   … in quit(): delivery.stop();
//
// and with three follow-ups from 10.4's review:
// - L3: the build-identity git calls (server/preview/identity.ts) run with
//   PREVIEW_GIT_ENV, so a check never refreshes the index or prompts;
// - L3 docs: docs/delivery-bootstrap.md no longer says the preview "writes
//   nothing". It writes only `~/.controlroom/<repoKey>/deliveries/` (each
//   ticket's delivery state and its lock files), the folder the kitchen uses for
//   the same tickets; the running (old) kitchen never reads or writes it, and the
//   core's cross-process locks guard it anyway;
// - L1 docs: the build stamp detects drift (a build that is not the reviewed
//   one), not tampering by a process running as the same user.
//
// Delivery reaches the preview only through `rpc.delivery`; no delivery
// operation is ever registered as a plain command, and both maps are looked up
// as own properties only (server/http.ts ownHandler).

import type { RpcHandler } from "../http";
import type { CoordinatorLink } from "./handback";
import { createDeliveryService, unavailableBoard, unavailableRpc, type DeliveryHub, type DeliveryService } from "./service";

/** The preview's plain commands: none, and a null prototype ("constructor" is no command). */
export const PREVIEW_COMMANDS_NONE: Record<string, (...args: unknown[]) => unknown> = Object.create(null);

/** For the preview's read-only identity git calls (10.4 L3): no optional locks, no prompts. */
export const PREVIEW_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });

export interface AttachedDelivery {
  rpc: Record<string, RpcHandler>;
  service: DeliveryService | null;
  start(): void;
  stop(): void;
}

/**
 * Delivery for a server, or `unavailable` when the repository has no GitHub
 * origin. The kitchen passes its coordinator session for the handback; a server
 * with no Pathfinder run (the preview) passes none, and its handback is refused.
 */
export function attachDelivery(o: { hub: DeliveryHub; root: string; github: string | null; kitchenKey: string; coordinator?: CoordinatorLink | null }): AttachedDelivery {
  const rpc: Record<string, RpcHandler> = Object.create(null);
  if (!o.github) {
    const reason = "Delivery needs a repository whose origin is on GitHub.";
    o.hub.snap.delivery = unavailableBoard(reason);
    rpc.delivery = unavailableRpc(reason);
    return { rpc, service: null, start() {}, stop() {} };
  }
  const service = createDeliveryService({ hub: o.hub, root: o.root, repo: o.github, kitchenKey: o.kitchenKey, coordinator: o.coordinator ?? null });
  rpc.delivery = service.handle;
  return { rpc, service, start: () => service.start(), stop: () => service.stop() };
}
