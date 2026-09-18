import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { type DB, newId, now, sha256 } from './db.ts';
import type { ArtifactKind, ArtifactView } from '../shared/types.ts';

export type ArtifactRow = {
  id: string;
  kind: ArtifactKind;
  rel_path: string | null;
  text: string | null;
  mime: string | null;
  byte_size: number | null;
  hash: string | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  producing_attempt_id: string | null;
  created_at: number;
};

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

export class ArtifactStore {
  db: DB;
  cfg: Config;
  /** test hook: simulate disk failure */
  failWrites = false;
  constructor(db: DB, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
  }

  get(id: string): ArtifactRow | null {
    return (this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined) ?? null;
  }

  absPath(row: ArtifactRow): string {
    if (!row.rel_path) throw new Error('artifact has no file');
    const p = path.resolve(this.cfg.mediaDir, row.rel_path);
    if (!p.startsWith(this.cfg.mediaDir + path.sep)) throw new Error('path escapes media dir');
    return p;
  }

  readBytes(row: ArtifactRow): Buffer {
    return fs.readFileSync(this.absPath(row));
  }

  saveText(text: string, producingAttemptId: string | null): ArtifactRow {
    const id = newId('art');
    this.db
      .prepare(
        'INSERT INTO artifacts(id, kind, text, mime, byte_size, hash, producing_attempt_id, created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(id, 'text', text, 'text/plain', Buffer.byteLength(text), sha256(text), producingAttemptId, now());
    return this.get(id)!;
  }

  /** temp write → fsync → atomic rename → commit DB row. The row only exists once the file is durable. */
  saveMedia(
    kind: 'image' | 'video',
    bytes: Buffer,
    meta: { mime: string; width?: number; height?: number; durationSec?: number },
    producingAttemptId: string | null,
  ): ArtifactRow {
    if (this.failWrites) throw Object.assign(new Error('ENOSPC: simulated disk write failure'), { code: 'ENOSPC' });
    const ext = EXT[meta.mime];
    if (!ext) throw new Error(`unsupported media type ${meta.mime}`);
    const id = newId('art');
    const rel = `${id}.${ext}`;
    const tmp = path.join(this.cfg.tmpDir, `${rel}.part`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(this.cfg.mediaDir, rel));
    this.db
      .prepare(
        'INSERT INTO artifacts(id, kind, rel_path, mime, byte_size, hash, width, height, duration_sec, producing_attempt_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        kind,
        rel,
        meta.mime,
        bytes.length,
        sha256(bytes),
        meta.width ?? null,
        meta.height ?? null,
        meta.durationSec ?? null,
        producingAttemptId,
        now(),
      );
    return this.get(id)!;
  }

  view(row: ArtifactRow | null | undefined): ArtifactView | undefined {
    if (!row) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      text: row.text ?? undefined,
      mime: row.mime ?? undefined,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      durationSec: row.duration_sec ?? undefined,
      byteSize: row.byte_size ?? undefined,
    };
  }
}
