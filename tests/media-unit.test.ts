import { afterAll, describe, expect, it } from 'vitest';
import dns from 'node:dns/promises';
import { MediaError, assertPublicHttpsUrl, inspectGeneratedImage, probeVideo, safeDownload } from '../server/media.ts';
import { closeAll, makeMp4, makePng, makeDataDir } from './helpers.ts';

afterAll(closeAll);

const lookupTo = (...addresses: string[]) =>
  (async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) as unknown as typeof dns.lookup;

const PUBLIC = lookupTo('93.184.216.34');

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (e) {
    return e instanceof MediaError ? e.kind : `UNEXPECTED:${String(e)}`;
  }
}

describe('assertPublicHttpsUrl', () => {
  it('rejects non-https schemes', async () => {
    for (const url of ['http://example.com/a.mp4', 'file:///etc/passwd', 'ftp://example.com/a.mp4', 'data:video/mp4;base64,AAAA']) {
      expect(`${url}:${await kindOf(assertPublicHttpsUrl(url, PUBLIC))}`).toBe(`${url}:unsafe_url`);
    }
  });

  it('rejects malformed URLs', async () => {
    expect(await kindOf(assertPublicHttpsUrl('not a url', PUBLIC))).toBe('unsafe_url');
    expect(await kindOf(assertPublicHttpsUrl('', PUBLIC))).toBe('unsafe_url');
  });

  it('rejects literal private and loopback addresses', async () => {
    const urls = [
      'https://10.1.2.3/x', 'https://127.0.0.1/x', 'https://192.168.1.5/x', 'https://169.254.169.254/latest/meta-data',
      'https://172.16.0.1/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x',
      'https://100.64.0.1/x',
    ];
    for (const url of urls) {
      expect(`${url}:${await kindOf(assertPublicHttpsUrl(url, PUBLIC))}`).toBe(`${url}:unsafe_url`);
    }
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    expect(await kindOf(assertPublicHttpsUrl('https://sneaky.example.com/a.mp4', lookupTo('10.0.0.5')))).toBe('unsafe_url');
    expect(await kindOf(assertPublicHttpsUrl('https://sneaky.example.com/a.mp4', lookupTo('::1')))).toBe('unsafe_url');
    // any private address among the results is enough to refuse
    expect(await kindOf(assertPublicHttpsUrl('https://mixed.example.com/a.mp4', lookupTo('93.184.216.34', '127.0.0.1')))).toBe('unsafe_url');
    // and an empty resolution is refused too
    expect(await kindOf(assertPublicHttpsUrl('https://nowhere.example.com/a.mp4', lookupTo()))).toBe('unsafe_url');
  });

  it('accepts a public https URL', async () => {
    const u = await assertPublicHttpsUrl('https://fal.media/files/out.mp4', PUBLIC);
    expect(u.hostname).toBe('fal.media');
  });
});

describe('safeDownload', () => {
  const ok = (body: Buffer, headers: Record<string, string> = {}) =>
    new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length), ...headers } });

  it('downloads a public https URL', async () => {
    const payload = Buffer.from('hello video bytes');
    const bytes = await safeDownload('https://fal.media/a.mp4', { fetchImpl: (async () => ok(payload)) as any, lookup: PUBLIC });
    expect(bytes.equals(payload)).toBe(true);
  });

  it('re-validates redirects and refuses one pointing at a private address', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: any) => {
      seen.push(String(u));
      if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://internal.example.com/secret' } });
      return ok(Buffer.from('should never get here'));
    }) as any;
    const lookup = (async (host: string) =>
      host === 'internal.example.com' ? [{ address: '10.0.0.9', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]) as any;
    expect(await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl, lookup }))).toBe('unsafe_url');
    expect(seen).toHaveLength(1); // never fetched the private target
  });

  it('follows a public redirect but gives up after too many hops', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n <= 2) return new Response(null, { status: 302, headers: { location: `https://cdn.example.com/hop${n}` } });
      return ok(Buffer.from('final'));
    }) as any;
    expect((await safeDownload('https://fal.media/a.mp4', { fetchImpl, lookup: PUBLIC })).toString()).toBe('final');

    const loop = (async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/again' } })) as any;
    expect(await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl: loop, lookup: PUBLIC }))).toBe('download_failed');

    const noLocation = (async () => new Response(null, { status: 302 })) as any;
    expect(await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl: noLocation, lookup: PUBLIC }))).toBe('download_failed');
  });

  it('enforces maxBytes by content-length and by streamed size', async () => {
    const big = Buffer.alloc(5000, 1);
    const byHeader = (async () => ok(big)) as any;
    expect(await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl: byHeader, lookup: PUBLIC, maxBytes: 1000 }))).toBe('too_large');

    // lying content-length: the stream itself is still capped
    const lying = (async () => new Response(new Uint8Array(big), { status: 200, headers: { 'content-length': '10' } })) as any;
    expect(await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl: lying, lookup: PUBLIC, maxBytes: 1000 }))).toBe('too_large');

    // just under the limit is fine
    const small = Buffer.alloc(900, 2);
    const okFetch = (async () => ok(small)) as any;
    expect((await safeDownload('https://fal.media/a.mp4', { fetchImpl: okFetch, lookup: PUBLIC, maxBytes: 1000 })).length).toBe(900);
  });

  it('maps 403/404/410 to expired_url and other failures to download_failed', async () => {
    for (const status of [403, 404, 410]) {
      const f = (async () => new Response('gone', { status })) as any;
      expect(`${status}:${await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl: f, lookup: PUBLIC }))}`).toBe(`${status}:expired_url`);
    }
    for (const status of [400, 500, 503]) {
      const f = (async () => new Response('nope', { status })) as any;
      expect(`${status}:${await kindOf(safeDownload('https://fal.media/a.mp4', { fetchImpl: f, lookup: PUBLIC }))}`).toBe(`${status}:download_failed`);
    }
  });
});

describe('generated media validation', () => {
  it('accepts a real PNG and reports its dimensions', async () => {
    const r = await inspectGeneratedImage(await makePng(32, 24));
    expect(r).toMatchObject({ mime: 'image/png', width: 32, height: 24 });
  });

  it('rejects undecodable image bytes with corrupt_media', async () => {
    expect(await kindOf(inspectGeneratedImage(Buffer.alloc(500, 9)))).toBe('corrupt_media');
  });

  it('probes a real MP4 and rejects non-MP4 data', async () => {
    const dir = makeDataDir();
    const v = await probeVideo(makeMp4(), dir);
    expect(v.mime).toBe('video/mp4');
    expect(v.width).toBe(320);
    expect(v.durationSec).toBeGreaterThan(0);
    expect(await kindOf(probeVideo(Buffer.from('not a video at all, really'), dir))).toBe('corrupt_media');
    // an MP4 header with garbage inside still fails at ffprobe
    const fakeFtyp = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]);
    expect(await kindOf(probeVideo(fakeFtyp, dir))).toBe('corrupt_media');
  });
});
