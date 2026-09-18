import fs from 'node:fs';
import path from 'node:path';
import { type DB, newId, now, tx } from './db.ts';
import type { ArtifactStore } from './artifacts.ts';
import type { Runner } from './runner.ts';

/** Portable run bundle: run.json + media files. Lets a fresh clone replay a real rehearsal with zero API calls. */
export function exportRun(runner: Runner, store: ArtifactStore, runId: string, outDir: string) {
  const v = runner.view(runId);
  if (v.status !== 'completed') throw new Error('Only completed runs can be exported.');
  fs.mkdirSync(outDir, { recursive: true });
  const art = (id: string) => {
    const row = store.get(id)!;
    if (row.rel_path) fs.copyFileSync(store.absPath(row), path.join(outDir, row.rel_path));
    return { kind: row.kind, file: row.rel_path, text: row.text, mime: row.mime, width: row.width, height: row.height, durationSec: row.duration_sec };
  };
  const bundle = {
    bundleVersion: 1, name: v.name, exportedAt: new Date().toISOString(), startingKind: v.startingKind, source: art(v.source.id),
    steps: v.steps.map((s) => {
      const a = s.attempts.find((x) => x.status === 'succeeded');
      return { definition: s.definition, artifact: art(s.artifact!.id), elapsedMs: a ? (a.finishedAt ?? 0) - a.submittedAt : null, costUsd: a?.costUsd ?? null, costStatus: a?.costStatus ?? 'unknown', providerModel: a?.providerModel, providerName: a?.providerName, expandedPrompt: a?.expandedPrompt ?? null };
    }),
  };
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(bundle, null, 2) + '\n');
}

export function importRunBundle(db: DB, store: ArtifactStore, dir: string): string | null {
  const file = path.join(dir, 'run.json');
  if (!fs.existsSync(file)) return null;
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = `imported:${b.name}:${b.exportedAt}`;
  if (db.prepare('SELECT 1 FROM kv WHERE key = ?').get(key)) return null;
  const mk = (a: any, attemptId: string | null) =>
    a.kind === 'text' ? store.saveText(a.text, attemptId) : store.saveMedia(a.kind, fs.readFileSync(path.join(dir, path.basename(a.file))), { mime: a.mime, width: a.width, height: a.height, durationSec: a.durationSec }, attemptId);
  const runId = newId('run');
  const src = mk(b.source, null);
  const made = b.steps.map((s: any) => { const attemptId = newId('att'); return { s, attemptId, art: mk(s.artifact, attemptId) }; });
  tx(db, () => {
    const t = now();
    db.prepare("INSERT INTO runs(id, name, snapshot, source_artifact_id, status, current_step_index, imported, created_at, started_at, finished_at) VALUES(?,?,?,?,'completed',?,1,?,?,?)")
      .run(runId, `${b.name} (saved rehearsal)`, JSON.stringify({ schemaVersion: 1, name: b.name, startingKind: b.startingKind, steps: b.steps.map((s: any) => s.definition) }), src.id, b.steps.length, t, t, t);
    made.forEach(({ s, attemptId, art }: any, i: number) => {
      const stx = newId('stx');
      db.prepare("INSERT INTO step_executions(id, run_id, step_index, definition_id, predecessor_artifact_id, status, successful_attempt_id, artifact_id, started_at, finished_at) VALUES(?,?,?,?,?,'succeeded',?,?,?,?)")
        .run(stx, runId, i, s.definition.id, i === 0 ? src.id : made[i - 1].art.id, attemptId, art.id, t, t + (s.elapsedMs ?? 0));
      db.prepare("INSERT INTO attempts(id, step_execution_id, status, submitted_at, finished_at, cost_usd, cost_status, provider_model, provider_name, expanded_prompt) VALUES(?,?,'succeeded',?,?,?,?,?,?,?)")
        .run(attemptId, stx, t, t + (s.elapsedMs ?? 0), s.costUsd, s.costStatus, s.providerModel ?? null, s.providerName ?? null, s.expandedPrompt);
    });
    db.prepare('INSERT INTO kv(key, value, updated_at) VALUES(?,?,?)').run(key, JSON.stringify(runId), t);
  });
  return runId;
}
