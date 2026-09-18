/** Export a completed run as a portable replay bundle:  npm run export-run -- <runId> [outDir] */
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { ArtifactStore } from '../server/artifacts.ts';
import { EventBus } from '../server/events.ts';
import { Runner } from '../server/runner.ts';
import { exportRun } from '../server/fixtures.ts';

const [runId, out] = process.argv.slice(2);
if (!runId) { console.error('usage: npm run export-run -- <runId> [outDir]'); process.exit(2); }
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const store = new ArtifactStore(db, cfg);
const runner = new Runner(db, store, cfg, {} as any, new EventBus(db));
const dir = path.resolve(out ?? path.join(cfg.rootDir, 'fixtures', 'rehearsal'));
exportRun(runner, store, runId, dir);
console.log(`exported ${runId} → ${dir}`);
