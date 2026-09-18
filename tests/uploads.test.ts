import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  HOST, ORIGIN, closeAll, get, makeApp, makeJpeg, makePng, multipartBody, post, testConfig, uploadDesktop,
} from './helpers.ts';

afterEach(closeAll);

describe('uploads', () => {
  it('sniffs bytes: a text file named .jpg is rejected with 415', async () => {
    const app = await makeApp();
    const res = await uploadDesktop(app, Buffer.from('I am plain text pretending to be a photo.\n'.repeat(20)), 'photo.jpg');
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatch(/not a readable image/i);
    expect((await get(app, '/api/session')).json().uploads).toHaveLength(0);
  });

  it('accepts a PNG declared as image/jpeg, judging content not the declared type', async () => {
    const app = await makeApp();
    const res = await uploadDesktop(app, await makePng(120, 90), 'lies.jpg', 'image/jpeg');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 120, height: 90 });
    const session = res.json().session;
    expect(session.uploads[0].artifact.mime).toBe('image/png'); // kept as PNG based on real content
  });

  it('rejects an over-limit upload with 413', async () => {
    const cfg = testConfig({ maxUploadBytes: 2000 });
    const app = await makeApp({ cfg });
    const big = await makeJpeg(800, 600);
    expect(big.length).toBeGreaterThan(2000);
    const res = await uploadDesktop(app, big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/larger than/i);
  });

  it('enforces the per-session upload count limit with 429', async () => {
    const cfg = testConfig({ maxUploadsPerSession: 2 });
    const app = await makeApp({ cfg });
    const png = await makePng(16, 16);
    expect((await uploadDesktop(app, png, 'a.png', 'image/png')).statusCode).toBe(200);
    expect((await uploadDesktop(app, png, 'b.png', 'image/png')).statusCode).toBe(200);
    const third = await uploadDesktop(app, png, 'c.png', 'image/png');
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatch(/upload limit/i);

    // the phone route shares the same limit
    const session = (await get(app, '/api/session')).json();
    const m = multipartBody('file', 'phone.png', 'image/png', png);
    const phone = await app.app.inject({
      method: 'POST', url: `/api/sessions/${session.id}/uploads`,
      headers: { host: HOST, origin: ORIGIN, ...m.headers, 'x-upload-token': session.uploadToken },
      payload: m.body,
    });
    expect(phone.statusCode).toBe(429);
  });

  it('applies EXIF orientation 6 (swapped dimensions) and strips all metadata', async () => {
    const app = await makeApp();
    const rotated = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    const res = await uploadDesktop(app, rotated, 'portrait.jpg');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 100, height: 200 }); // swapped by the rotation
    expect(res.json().transformations).toContain('exif-orientation-applied');
    expect(res.json().transformations).toContain('metadata-stripped');

    const artifactId = res.json().session.uploads[0].artifact.id;
    const out = app.store.readBytes(app.store.get(artifactId)!);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it('caps the long edge at 2048px', async () => {
    const app = await makeApp();
    const huge = await makeJpeg(3000, 1500);
    const res = await uploadDesktop(app, huge);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 2048, height: 1024 });
    expect(res.json().transformations).toContain('resized-long-edge-2048');
  });

  it('never stores the client filename anywhere', async () => {
    const app = await makeApp();
    const name = 'IMG_HIGHLY-DISTINCTIVE-NAME_0042.jpg';
    expect((await uploadDesktop(app, await makeJpeg(), name)).statusCode).toBe(200);
    const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    for (const t of tables) {
      expect(JSON.stringify(app.db.prepare(`SELECT * FROM ${t}`).all())).not.toContain('HIGHLY-DISTINCTIVE-NAME');
    }
    expect((await get(app, '/api/session')).body).not.toContain('HIGHLY-DISTINCTIVE-NAME');
  });

  it('the phone route requires a valid upload token', async () => {
    const app = await makeApp();
    const session = (await get(app, '/api/session')).json();
    const m = multipartBody('file', 'p.png', 'image/png', await makePng());
    const bad = await app.app.inject({
      method: 'POST', url: `/api/sessions/${session.id}/uploads`,
      headers: { host: HOST, origin: ORIGIN, ...m.headers, 'x-upload-token': 'n'.repeat(43) },
      payload: m.body,
    });
    expect(bad.statusCode).toBe(401);
    const missing = await app.app.inject({
      method: 'POST', url: `/api/sessions/${session.id}/uploads`,
      headers: { host: HOST, origin: ORIGIN, ...m.headers },
      payload: m.body,
    });
    expect(missing.statusCode).toBe(401);
  });

  it('accepting an upload sets the source but never starts a run', async () => {
    const app = await makeApp();
    const up = await uploadDesktop(app, await makeJpeg());
    const uploadId = up.json().uploadId;
    let session = (await get(app, '/api/session')).json();
    expect(session.source).toBeNull();
    expect(session.uploads[0].status).toBe('pending');

    session = (await post(app, `/api/session/uploads/${uploadId}/accept`, {})).json();
    expect(session.source.kind).toBe('image');
    expect(session.uploads[0].status).toBe('accepted');
    expect((await get(app, '/api/runs')).json().runs).toEqual([]);

    const rejected = (await post(app, `/api/session/uploads/${uploadId}/reject`, {})).json();
    expect(rejected.uploads[0].status).toBe('rejected');
    expect((await post(app, '/api/session/uploads/upl_missing/accept', {})).statusCode).toBe(404);
  });
});
