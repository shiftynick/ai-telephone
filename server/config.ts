import fs from 'node:fs';
import path from 'node:path';

export type Config = {
  port: number;
  dataDir: string;
  mediaDir: string;
  tmpDir: string;
  dbPath: string;
  openrouterKey: string;
  falKey: string;
  mock: boolean;
  devWebPort: number | null;
  defaultBudgetUsd: number | null;
  maxUploadBytes: number;
  maxUploadsPerSession: number;
  rootDir: string;
};

function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const rootDir = path.resolve(import.meta.dirname, '..');
  loadDotEnv(path.join(rootDir, '.env'));
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(rootDir, 'data'));
  const budget = process.env.RUN_BUDGET_USD;
  const cfg: Config = {
    port: Number(process.env.PORT ?? 8787),
    dataDir,
    mediaDir: path.join(dataDir, 'media'),
    tmpDir: path.join(dataDir, 'tmp'),
    dbPath: path.join(dataDir, 'telephone.sqlite'),
    openrouterKey: process.env.OPENROUTER_API_KEY ?? '',
    falKey: process.env.FAL_KEY ?? '',
    mock: process.env.MOCK_PROVIDERS === '1',
    devWebPort: process.env.DEV_WEB_PORT ? Number(process.env.DEV_WEB_PORT) : null,
    defaultBudgetUsd: budget === undefined ? 2 : budget === '' ? null : Number(budget),
    maxUploadBytes: 20 * 1024 * 1024,
    maxUploadsPerSession: 50,
    rootDir,
    ...overrides,
  };
  cfg.mediaDir = path.join(cfg.dataDir, 'media');
  cfg.tmpDir = path.join(cfg.dataDir, 'tmp');
  if (!overrides.dbPath) cfg.dbPath = path.join(cfg.dataDir, 'telephone.sqlite');
  fs.mkdirSync(cfg.mediaDir, { recursive: true });
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  return cfg;
}
