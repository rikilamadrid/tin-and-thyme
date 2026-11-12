// The delivery request as it arrives over the kitchen's WebSocket:
//
//   { rpc: "delivery", id, op, params }
//
// `id` matches /^[A-Za-z0-9_-]{1,64}$/ and comes back on the reply. `op` is one of
// the named operations (eight up to the merge, four after it), looked up as an
// own property only. `params` holds exactly the fields that op takes: a ticket
// key, full commit/tree ids and a listing digest, never a title, a body, a flag
// or a command. Anything else is refused as `invalid` before the delivery core
// is reached.

import { DELIVERY_OPS, type DeliveryOp } from "../../src/data/delivery";
import { isSha } from "./ops";
import { isPlanDigest } from "./reconcile";
import { isTicketKey } from "./state";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The fields each operation takes. A null-prototype map: "constructor" or "__proto__" is no operation. */
const PARAMS: Record<DeliveryOp, readonly string[]> = Object.assign(Object.create(null) as Record<DeliveryOp, readonly string[]>, {
  inspect: ["key"],
  approve: ["key", "head", "base", "tree"],
  acknowledgeNoChecks: ["key", "head", "base", "tree"],
  push: ["key", "head"],
  ensurePr: ["key"],
  status: ["key"],
  merge: ["key", "head", "base", "tree"],
  verify: ["key"],
  reconcilePlan: ["key"],
  reconcile: ["key", "digest"],
  handback: ["key"],
  plan: ["key"],
} satisfies Record<DeliveryOp, readonly string[]>);

export interface DeliveryParams {
  key: string;
  head?: string;
  base?: string;
  tree?: string;
  /** reconcile: the digest of the listing the human was shown. */
  digest?: string;
}

export interface DeliveryRequest {
  id: string;
  op: DeliveryOp;
  params: DeliveryParams;
}

export type Parsed = { ok: true; req: DeliveryRequest } | { ok: false; id: string | null; op: DeliveryOp | null; key: string | null; message: string };

export const isRequestId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
export const isDeliveryOp = (v: unknown): v is DeliveryOp => typeof v === "string" && Object.hasOwn(PARAMS, v) && (DELIVERY_OPS as readonly string[]).includes(v);

/** Only the id, for a reply to a message that fails validation. */
export function requestIdOf(raw: unknown): string | null {
  return raw && typeof raw === "object" && isRequestId((raw as { id?: unknown }).id) ? (raw as { id: string }).id : null;
}

export function parseRequest(raw: unknown): Parsed {
  const id = requestIdOf(raw);
  const fail = (message: string, op: DeliveryOp | null = null, key: string | null = null): Parsed => ({ ok: false, id, op, key, message });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not a delivery request");
  const msg = raw as Record<string, unknown>;
  for (const k of Object.keys(msg)) if (k !== "rpc" && k !== "id" && k !== "op" && k !== "params") return fail(`unknown field ${JSON.stringify(k).slice(0, 40)}`);
  if (msg.rpc !== "delivery") return fail("not a delivery request");
  if (!id) return fail("the request id must be 1 to 64 letters, digits, _ or -");
  if (!isDeliveryOp(msg.op)) return fail(`unknown operation ${JSON.stringify(String(msg.op)).slice(0, 40)}`);
  const op = msg.op;
  const p = msg.params;
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail("params must be an object", op);
  const params = p as Record<string, unknown>;
  const allowed = PARAMS[op];
  for (const k of Object.keys(params)) if (!allowed.includes(k)) return fail(`${op} takes no ${JSON.stringify(k).slice(0, 40)}`, op);
  if (!isTicketKey(params.key)) return fail("key must be a ticket key like 10.2", op);
  const key = params.key;
  const out: DeliveryParams = { key };
  for (const f of ["head", "base", "tree"] as const) {
    if (!allowed.includes(f)) continue;
    if (!isSha(params[f])) return fail(`${f} must be a full 40-character id`, op, key);
    out[f] = params[f] as string;
  }
  if (allowed.includes("digest")) {
    if (!isPlanDigest(params.digest)) return fail("digest must be the 64-character listing digest", op, key);
    out.digest = params.digest;
  }
  return { ok: true, req: { id, op, params: out } };
}
