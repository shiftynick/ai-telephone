import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, acceptSource, closeAll, createRun, makeApp, post, preset, step, testConfig, waitFor, type TestApp } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';

type SseEvent = { id?: number; event: string; data: any };
type Stream = { events: SseEvent[]; ready: Promise<void>; close: () => Promise<void> };

const openStreams: Stream[] = [];

afterEach(async () => {
  for (const s of openStreams.splice(0)) await s.close();
  await new Promise((r) => setTimeout(r, 20)); // let the server observe the closed sockets
  await closeAll();
});

/** Reads an SSE stream into an array until aborted. */
function openSse(url: string, headers: Record<string, string>): Stream {
  const abort = new AbortController();
  const events: SseEvent[] = [];
  let markReady!: () => void;
  let markFailed!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => { markReady = res; markFailed = rej; });
  const done = (async () => {
    const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: abort.signal }).catch((e) => {
      markFailed(e);
      throw e;
    });
    if (res.status !== 200) {
      markFailed(new Error(`SSE status ${res.status}`));
      throw new Error(`SSE status ${res.status}`);
    }
    markReady();
    let buf = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          const e: SseEvent = { event: 'message', data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) e.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) e.event = line.slice(7);
            else if (line.startsWith('data: ')) e.data = JSON.parse(line.slice(6));
            }
          if (e.data !== null) events.push(e);
        }
      }
    } catch {
      /* aborted */
    }
  })().catch(() => {});
  const s: Stream = { events, ready, close: async () => { abort.abort(); await done; } };
  openStreams.push(s);
  return s;
}

async function listeningApp(): Promise<{ app: TestApp; base: string; mock: MockAdapter }> {
  const cfg = testConfig();
  const mock = new MockAdapter(cfg.tmpDir, 0);
  const app = await makeApp({ cfg, adapters: { openrouter: mock, fal: mock } });
  const address = await app.app.listen({ port: 0, host: '127.0.0.1' });
  const port = new URL(address).port;
  app.allowedHosts.add(`127.0.0.1:${port}`);
  return { app, base: `http://127.0.0.1:${port}`, mock };
}

describe('SSE', () => {
  it('streams run events and replays only newer events after Last-Event-ID', async () => {
    const { app, base } = await listeningApp();
    const cookie = app.cookie;
    await acceptSource(app);
    const id = (await createRun(app, {
      preset: preset('sse run', [
        step('image_to_text', MODELS.describe, 'D1', 'e1'),
        step('text_to_image', MODELS.draw, 'G1', 'e2'),
        step('image_to_text', MODELS.describe, 'D2', 'e3'),
      ]),
    })).json().id;

    const first = openSse(`${base}/api/runs/${id}/events`, { cookie });
    await first.ready;
    await post(app, `/api/runs/${id}/actions`, { action: 'start' });
    await app.runner.idle();
    await waitFor(() => first.events.some((e) => e.data.type === 'run.completed'), 'run.completed over SSE');
    await first.close();

    const types = first.events.map((e) => e.data.type);
    expect(types).toContain('run.running');
    expect(types.filter((t) => t === 'step.succeeded')).toHaveLength(3);
    expect(types.at(-1)).toBe('run.completed');
    expect(first.events.every((e) => e.data.runId === id)).toBe(true);
    expect(first.events.every((e) => typeof e.id === 'number' && e.id! > 0)).toBe(true);
    expect(first.events.map((e) => e.id)).toEqual([...first.events.map((e) => e.id)].sort((a, b) => a! - b!));
    // event payloads are invalidation pings, never artifact content
    expect(JSON.stringify(first.events)).not.toMatch(/Mock description/);

    // reconnect from the middle: only newer events are replayed
    const cut = first.events[1].id!;
    const second = openSse(`${base}/api/runs/${id}/events`, { cookie, 'last-event-id': String(cut) });
    await second.ready;
    await waitFor(() => second.events.some((e) => e.data.type === 'run.completed'), 'replayed run.completed');
    await second.close();

    expect(second.events.every((e) => e.id! > cut)).toBe(true);
    expect(second.events.map((e) => e.id)).toEqual(first.events.filter((e) => e.id! > cut).map((e) => e.id));

    // a fresh connection with no Last-Event-ID replays nothing historical
    const third = openSse(`${base}/api/runs/${id}/events`, { cookie });
    await third.ready;
    await new Promise((r) => setTimeout(r, 80));
    expect(third.events).toHaveLength(0);
    await third.close();
  }, 30_000);

  it('requires the host cookie for event streams and a valid token for projector streams', async () => {
    const { app, base } = await listeningApp();
    const unauth = await fetch(`${base}/api/events`, { headers: { accept: 'text/event-stream' } });
    expect(unauth.status).toBe(401);
    await unauth.body?.cancel();

    const session = (await post(app, '/api/session/rotate', { which: 'both' })).json();
    const bad = await fetch(`${base}/api/present/${'z'.repeat(43)}/events`);
    expect(bad.status).toBe(404);
    await bad.body?.cancel();

    const good = openSse(`${base}/api/present/${session.projectorToken}/events`, {});
    await good.ready;
    await post(app, '/api/session/rotate', { which: 'projector' });
    await waitFor(() => good.events.length > 0, 'a projector ping');
    expect(good.events[0].event).toBe('change');
    expect(good.events[0].data).toEqual({}); // content-free
    await good.close();
  }, 30_000);
});
