// Delivery request/reply over the kitchen's WebSocket.
//
// Browser → server: { rpc: "delivery", id, op, params }. The server answers the
// requesting socket only with { type: "delivery.reply", id, reply }.
// A request is never queued: when the socket is not open it fails at once, and a
// connection lost mid-request resolves as "connection lost — see the steps" (the
// steps come back with the next snapshot, which carries the delivery state).

import type { DeliveryClient, DeliveryOp, DeliveryReply } from "../delivery";

export interface DeliveryTransport {
  /** Sends the frame now; false when the socket is not open. */
  send(frame: string): boolean;
}

export interface DeliveryClientControl extends DeliveryClient {
  /** A `delivery.reply` event arrived. */
  onReply(id: string | null, reply: DeliveryReply): void;
  /** The socket closed: every request in flight resolves as lost. */
  connectionLost(): void;
}

let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 64);

export function createDeliveryClient(t: DeliveryTransport): DeliveryClientControl {
  const pending = new Map<string, { op: DeliveryOp; key: string | null; resolve: (r: DeliveryReply) => void }>();
  const lost = (id: string, op: DeliveryOp, key: string | null, message: string): DeliveryReply => ({ ok: false, id, op, key, kind: "unavailable", message, fix: null, reasons: [], view: null });
  return {
    request(op, params) {
      const id = newId();
      const key = typeof params.key === "string" ? params.key : null;
      return new Promise<DeliveryReply>((resolve) => {
        pending.set(id, { op, key, resolve });
        if (!t.send(JSON.stringify({ rpc: "delivery", id, op, params }))) {
          pending.delete(id);
          resolve(lost(id, op, key, "Not connected to the kitchen: nothing was sent."));
        }
      });
    },
    onReply(id, reply) {
      if (!id) return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      p.resolve(reply);
    },
    connectionLost() {
      for (const [id, p] of pending) p.resolve(lost(id, p.op, p.key, "Connection lost — see the steps: what ran is shown there once the kitchen reconnects."));
      pending.clear();
    },
  };
}
