// Sticky notes on the plan wall. They glide between columns as tasks move.

import type { Task, TaskStatus } from "../../data/types";
import { shade } from "../../theme/tokens";
import { C } from "../engine/palette";
import type { Pen } from "../engine/pen";
import type { PxRect } from "../layout/layout";

// Reviewed (ready to deliver) shares the review column but never its mark.
const COLS: Record<TaskStatus, number> = { todo: 0, blocked: 0, "in-progress": 1, "in-review": 2, reviewed: 2, done: 3 };

interface Note {
  x: number;
  y: number;
  tx: number;
  ty: number;
  hidden: boolean;
  born: number;
}

export class PlanNotes {
  private notes = new Map<string, Note>();
  private boardId: string | null = null;

  update(tasks: Task[], boardId: string | null, board: PxRect, dt: number, t: number) {
    if (boardId !== this.boardId) {
      this.notes.clear();
      this.boardId = boardId;
    }
    const mine = tasks.filter((x) => x.boardId === boardId);
    const seen = new Set<string>();
    for (let col = 0; col < 4; col++) {
      const list = mine.filter((x) => COLS[x.status] === col);
      if (col === 3) list.reverse(); // most recent done first
      list.forEach((task, i) => {
        seen.add(task.id);
        const tx = board.x + col * 35 + 2 + (i % 4) * 8;
        const ty = board.y + 11 + Math.floor(i / 4) * 7;
        const n = this.notes.get(task.id);
        if (n) Object.assign(n, { tx, ty, hidden: i >= 16 });
        else this.notes.set(task.id, { x: tx, y: ty, tx, ty, hidden: i >= 16, born: this.notes.size ? t : -10 });
      });
    }
    for (const id of [...this.notes.keys()]) if (!seen.has(id)) this.notes.delete(id);
    const k = 1 - Math.exp(-5 * dt);
    for (const n of this.notes.values()) {
      n.x += (n.tx - n.x) * k;
      n.y += (n.ty - n.y) * k;
    }
  }

  draw(p: Pen, tasks: Task[], colorOf: (id: string | null) => string, t: number) {
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const sorted = [...this.notes.entries()].sort(
      ([, a], [, b]) => Math.abs(a.x - a.tx) + Math.abs(a.y - a.ty) - (Math.abs(b.x - b.tx) + Math.abs(b.y - b.ty)),
    );
    for (const [id, n] of sorted) {
      const task = byId.get(id);
      if (!task || n.hidden) continue;
      const color = colorOf(task.ownerId);
      const dist = Math.abs(n.x - n.tx) + Math.abs(n.y - n.ty);
      const lift = dist > 1 ? Math.min(3, dist / 6) : 0;
      const x = Math.round(n.x);
      const y = Math.round(n.y - lift);
      if (lift) p.rect(x + 1, y + lift + 1, 7, 6, C.shadow, 0.25);
      if (task.status === "done") {
        p.rect(x, y, 7, 6, "#ddd5c4");
        p.rect(x, y, 2, 6, color);
        p.rect(x + 3, y + 3, 1, 1, "#008751");
        p.rect(x + 4, y + 2, 1, 1, "#008751");
        p.rect(x + 5, y + 1, 1, 1, "#008751");
      } else {
        p.rect(x, y, 7, 6, color);
        p.rect(x, y, 7, 1, shade(color, 0.5));
        p.rect(x + 1, y + 3, 4, 1, shade(color, -0.3));
        if (task.status === "in-review") p.rect(x + 5, y + 4, 1, 1, C.ink);
        if (task.status === "reviewed") p.rect(x + 4, y + 4, 2, 1, C.green);
        if (task.status === "blocked") p.rect(x + 5, y + 1, 2, 2, C.red);
      }
      if (t - n.born < 0.6 && Math.floor(t * 10) % 2) {
        p.rect(x - 1, y - 1, 9, 1, C.white);
        p.rect(x - 1, y + 6, 9, 1, C.white);
      }
    }
  }
}
