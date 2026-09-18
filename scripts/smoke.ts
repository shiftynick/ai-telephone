/**
 * BILLABLE provider smoke test. Never run by `npm test`.
 *   npm run smoke -- --yes-bill-me [--types image_to_text,text_to_image,text_to_text,image_to_video,text_to_video] [--models id1,id2]
 * Records results in the local DB so the model picker shows tested-successfully / failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { ModelCatalog, FAVORITES } from '../server/models.ts';
import { OpenRouterAdapter } from '../server/providers/openrouter.ts';
import { FalAdapter } from '../server/providers/fal.ts';
import { inspectGeneratedImage, probeVideo } from '../server/media.ts';
import { DEFAULT_INSTRUCTIONS, STEP_TYPES, type StepType } from '../shared/types.ts';
import type { StepInput } from '../server/providers/types.ts';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!args.includes('--yes-bill-me')) {
  console.error('This makes PAID API calls with the keys in .env. Re-run with --yes-bill-me to proceed.');
  process.exit(2);
}
const types = (flag('--types') ?? 'text_to_image,image_to_text,text_to_text').split(',') as StepType[];
const only = flag('--models')?.split(',');

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const catalog = new ModelCatalog(db);
const adapters = { openrouter: new OpenRouterAdapter({ apiKey: cfg.openrouterKey }), fal: new FalAdapter({ apiKey: cfg.falKey }) };
const outDir = path.join(cfg.dataDir, 'smoke');
fs.mkdirSync(outDir, { recursive: true });

const SCENE = 'A tabletop still life photographed from slightly above: a red ceramic mug, a blue rubber duck sitting on top of a closed yellow hardcover book, and a small green cactus in a white pot. A small folded paper sign reading "OPEN LATE" leans against the mug. Warm window light from the left, plain wooden table, soft shadows.';
const sourceFile = path.join(cfg.rootDir, 'fixtures', 'source-still-life.jpg');

async function sourceImage(): Promise<StepInput> {
  if (!fs.existsSync(sourceFile)) throw new Error(`Missing ${sourceFile}; run the text_to_image smoke first.`);
  return { kind: 'image', bytes: fs.readFileSync(sourceFile), mime: 'image/jpeg' };
}

let total = 0;
const rows: string[] = [];
for (const type of types) {
  for (const modelId of FAVORITES[type]) {
    if (only && !only.includes(modelId)) continue;
    const input: StepInput = STEP_TYPES[type].input === 'text' ? { kind: 'text', text: SCENE } : await sourceImage();
    const params = type === 'text_to_image' ? { aspect_ratio: '16:9' } : type.endsWith('video') ? { resolution: '768P', duration: 5, prompt_expansion_mode: 'balanced' as const } : {};
    const t0 = Date.now();
    process.stdout.write(`${type}  ${modelId} … `);
    try {
      const r = await adapters[STEP_TYPES[type].provider].execute({
        type, modelId, instruction: DEFAULT_INSTRUCTIONS[type], params, input, signal: AbortSignal.timeout(900_000),
        onSubmitted: (i) => process.stdout.write(`[job ${i.requestId}] `),
      });
      const ms = Date.now() - t0;
      let detail = '';
      const safe = modelId.replace(/[^a-z0-9.-]/gi, '_');
      if (r.output.kind === 'text') detail = `${r.output.text.length} chars: "${r.output.text.slice(0, 90)}…"`;
      if (r.output.kind === 'image') {
        const img = await inspectGeneratedImage(r.output.bytes);
        fs.writeFileSync(path.join(outDir, `${safe}.${img.mime.split('/')[1]}`), img.bytes);
        detail = `${img.width}x${img.height} ${img.mime}`;
        if (!fs.existsSync(sourceFile)) {
          fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
          await sharp(img.bytes).jpeg({ quality: 92 }).toFile(sourceFile);
          detail += ' → saved as fixtures/source-still-life.jpg';
        }
      }
      if (r.output.kind === 'video') {
        const v = await probeVideo(r.output.bytes, cfg.tmpDir);
        fs.writeFileSync(path.join(outDir, `${safe}.mp4`), r.output.bytes);
        detail = `${v.width}x${v.height} ${v.durationSec.toFixed(1)}s, inference ${r.inferenceSec ?? '?'}s, expanded_prompt ${r.expandedPrompt ? 'recorded' : 'none'}`;
      }
      const cost = r.costUsd == null ? 'cost unknown' : `$${r.costUsd.toFixed(6)}`;
      if (r.costUsd) total += r.costUsd;
      console.log(`OK ${(ms / 1000).toFixed(1)}s  ${cost}  via ${r.providerName ?? '?'}  ${detail}`);
      rows.push(`| ${type} | ${modelId} | ${r.providerName ?? '?'} | OK | ${(ms / 1000).toFixed(1)}s | ${cost} |`);
      catalog.recordTest(modelId, type, 'tested-successfully', `Smoke test ${new Date().toISOString().slice(0, 10)}: ${(ms / 1000).toFixed(1)}s`, ms);
    } catch (e: any) {
      const ms = Date.now() - t0;
      console.log(`FAILED ${(ms / 1000).toFixed(1)}s  [${e?.kind ?? 'error'}] ${e?.message ?? e}`);
      rows.push(`| ${type} | ${modelId} | – | FAILED (${e?.kind ?? 'error'}) | ${(ms / 1000).toFixed(1)}s | – |`);
      catalog.recordTest(modelId, type, 'failed', String(e?.message ?? e).slice(0, 200), ms);
    }
  }
}
console.log(`\nKnown spend this run: $${total.toFixed(4)} (steps with unknown cost are NOT included)\n`);
console.log('| step type | model | provider | result | elapsed | cost |\n|---|---|---|---|---|---|');
console.log(rows.join('\n'));
