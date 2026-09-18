import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptSource, closeAll, createRun, makeApp, makeJpeg, quickChain, runToEnd, type TestApp,
} from './helpers.ts';
import { fakeAdapters, makeFalFake, makeOpenRouterFake, type FalFake, type OpenRouterFake } from './fakes.ts';

const FILENAME = 'unique-source-filename-ZZTOP.jpg';
const RUN_NAME = 'DISTINCTIVE-RUN-NAME-QQ7';

describe('telephone invariant', () => {
  let app: TestApp;
  let or: OpenRouterFake;
  let fal: FalFake;
  let sourceB64: string;
  let run: any;

  beforeAll(async () => {
    or = makeOpenRouterFake();
    fal = makeFalFake();
    app = await makeApp({ adapters: fakeAdapters(or, fal) });
    const jpeg = await makeJpeg();
    await acceptSource(app, jpeg, FILENAME);
    // the *normalized* source is what the runner sends
    const session = (await app.app.inject({ method: 'GET', url: '/api/session', headers: { host: 'localhost:8787', cookie: app.cookie } })).json();
    sourceB64 = app.store.readBytes(app.store.get(session.source.id)!).toString('base64');
    const created = await createRun(app, { preset: quickChain() });
    expect(created.statusCode).toBe(200);
    run = created.json();
    await runToEnd(app, run.id);
    run = (await app.app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { host: 'localhost:8787', cookie: app.cookie } })).json();
  });

  afterAll(closeAll);

  it('completes all five steps', () => {
    expect(run.status).toBe('completed');
    expect(run.steps.map((s: any) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
  });

  it('makes exactly one provider call per step', () => {
    expect(or.chatCalls.length).toBe(2);
    expect(or.imageCalls.length).toBe(2);
    expect(fal.submits.length).toBe(1);
  });

  it('sends exactly one user message and no system message per chat call', () => {
    for (const c of or.chatCalls) {
      expect(c.body.messages).toHaveLength(1);
      expect(c.body.messages[0].role).toBe('user');
      expect(JSON.stringify(c.body.messages).includes('"system"')).toBe(false);
    }
  });

  it('step 1 sends only the source image plus its own instruction', () => {
    const c = or.chatCalls[0];
    const parts = c.body.messages[0].content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'INSTRUCTION-ALPHA describe the image' });
    expect(parts[1].image_url.url).toBe(`data:image/jpeg;base64,${sourceB64}`);
  });

  it('later image_to_text never re-sends the original image bytes or hash', () => {
    const c = or.chatCalls[1];
    const url: string = c.body.messages[0].content[1].image_url.url;
    expect(url.includes(sourceB64)).toBe(false);
    expect(JSON.stringify(c.body).includes(sourceB64)).toBe(false);
  });

  it('step 3 carries no earlier description text and none of the earlier instructions', () => {
    const c = JSON.stringify(or.chatCalls[1].body);
    expect(c).toContain('INSTRUCTION-CHARLIE');
    for (const older of ['INSTRUCTION-ALPHA', 'INSTRUCTION-BRAVO', 'FAKE-TEXT-0']) expect(c).not.toContain(older);
  });

  it('image generation sends only its instruction + the immediately preceding text', () => {
    const b = or.imageCalls[1].body;
    expect(Object.keys(b).sort()).toEqual(['model', 'n', 'prompt']);
    expect('input_references' in b).toBe(false);
    // predecessor text is the second chat response (global call index 2)
    expect(b.prompt).toBe(`INSTRUCTION-DELTA draw the scene\n\nFAKE-TEXT-2 generated description of the predecessor artifact.`);
    expect(b.prompt).not.toContain('FAKE-TEXT-0');
    expect(b.prompt).not.toContain('INSTRUCTION-BRAVO');
  });

  it('no /images body contains an input_references key', () => {
    for (const c of or.imageCalls) expect(Object.keys(c.body)).not.toContain('input_references');
  });

  it('image_to_video sends only the uploaded predecessor image + the static motion instruction', () => {
    expect(fal.uploads).toHaveLength(1);
    const predecessorImage = app.store.readBytes(app.store.get(run.steps[3].artifact.id)!);
    expect(fal.uploads[0].bytes.equals(predecessorImage)).toBe(true);
    const input = fal.submits[0].input;
    expect(input.prompt).toBe('INSTRUCTION-ECHO animate the scene');
    expect(String(input.prompt)).not.toContain('INSTRUCTION-DELTA');
    expect(JSON.stringify(input)).not.toContain('FAKE-TEXT');
  });

  it('never leaks the source filename or the run/preset name to any provider', () => {
    const all = JSON.stringify([or.calls.map((c) => c.body), fal.submits, fal.uploads.map((u) => u.mime)]);
    expect(all).not.toContain(FILENAME);
    expect(all).not.toContain('unique-source-filename');
    expect(all).not.toContain(RUN_NAME);
  });

  it('never stores the source filename anywhere in the database', () => {
    const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    for (const t of tables) {
      const rows = app.db.prepare(`SELECT * FROM ${t}`).all() as any[];
      expect(JSON.stringify(rows)).not.toContain('unique-source-filename');
    }
  });
});
