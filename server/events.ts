import { type DB, now } from './db.ts';

export type BusEvent = { id: number; runId: string | null; type: string; payload: Record<string, unknown>; ts: number };
type Listener = (e: BusEvent) => void;

/** Persisted, monotonic event log + in-process fan-out. Payloads are "safe": never artifact content. */
export class EventBus {
  db: DB;
  private listeners = new Set<Listener>();
  constructor(db: DB) {
    this.db = db;
  }
  publish(runId: string | null, type: string, payload: Record<string, unknown> = {}) {
    const ts = now();
    const res = this.db.prepare('INSERT INTO events(run_id, type, payload, ts) VALUES(?,?,?,?)').run(runId, type, JSON.stringify(payload), ts);
    const e: BusEvent = { id: Number(res.lastInsertRowid), runId, type, payload, ts };
    for (const l of this.listeners) l(e);
  }
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  since(id: number, runId?: string): BusEvent[] {
    const rows = (runId
      ? this.db.prepare('SELECT * FROM events WHERE id > ? AND run_id = ? ORDER BY id LIMIT 500').all(id, runId)
      : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500').all(id)) as any[];
    return rows.map((r) => ({ id: r.id, runId: r.run_id, type: r.type, payload: JSON.parse(r.payload), ts: r.ts }));
  }
}
