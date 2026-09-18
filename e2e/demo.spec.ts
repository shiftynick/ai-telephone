import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

let server: ChildProcess;
let hostLink = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-e2e-'));
const photo = path.join(dataDir, 'photo.jpg');
const shots = path.join('test-results', 'shots');

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#b5523a' } }).jpeg().toFile(photo);
  server = spawn('node', ['server/index.ts'], { env: { ...process.env, PORT: '8797', DATA_DIR: dataDir, MOCK_PROVIDERS: '1', MOCK_DELAY_MS: '400' } });
  hostLink = await new Promise<string>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (d) => { out += d; const m = /http:\/\/localhost:8797\/host\?code=\S+/.exec(out); if (m) resolve(m[0]); });
    server.on('exit', () => reject(new Error(`server exited: ${out}`)));
  });
});
test.afterAll(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = (page: Page, url: string) => page.evaluate(async (u) => (await fetch(u)).json(), url);

test('host runs the quick demo; projector follows; phone page uploads', async ({ page, browser }) => {
  await page.goto(hostLink);
  await expect(page).toHaveURL(/\/host$/); // one-time code stripped
  await page.locator('input[type=file]').first().setInputFiles(photo);
  await page.getByRole('button', { name: /accept/i }).first().click();
  await page.getByRole('button', { name: /create run/i }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  const session = await api(page, '/api/session');
  await expect.poll(async () => (await api(page, `/api/runs/${session.selectedRunId ?? (await api(page, '/api/session')).selectedRunId}`)).status, { timeout: 60_000 }).toBe('completed');
  await page.screenshot({ path: path.join(shots, 'host.png'), fullPage: true });

  // Refreshing the host must not start or duplicate anything.
  const before = (await api(page, '/api/runs')).runs.length;
  await page.reload();
  await page.waitForTimeout(800);
  expect((await api(page, '/api/runs')).runs.length).toBe(before);

  // Projector: auto-reveal leaves the final video on stage.
  const projCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: 'http://localhost:8797' }); // no host cookie
  const projector = await projCtx.newPage();
  await projector.goto(`/present/${session.projectorToken}`);
  await expect(projector.locator('video')).toBeVisible();
  await projector.screenshot({ path: path.join(shots, 'projector-video.png') });

  // A projector token cannot mutate anything.
  const status = await projector.evaluate(async () => (await fetch('/api/session/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"reset"}' })).status);
  expect(status).toBe(401);
  await projCtx.close();

  // Phone page in a separate, cookie-less mobile context.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: 'http://localhost:8797' });
  const phone = await phoneCtx.newPage();
  await phone.goto(`/join/${session.uploadToken}`);
  await phone.locator('input[type=file]').last().setInputFiles(photo);
  await phone.getByRole('button', { name: /upload|send/i }).first().click();
  await expect(phone.getByText(/Sent!/)).toBeVisible();
  await phone.screenshot({ path: path.join(shots, 'phone.png') });
  expect((await phone.evaluate(async () => (await fetch('/api/runs')).status))).toBe(401);
  await phoneCtx.close();

  // The upload shows up for the host without starting a run.
  await expect.poll(async () => (await api(page, '/api/session')).uploads.filter((u: any) => u.origin === 'phone').length).toBe(1);
  expect((await api(page, '/api/runs')).runs.length).toBe(before);
});
