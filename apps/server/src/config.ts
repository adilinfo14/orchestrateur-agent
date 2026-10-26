import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export const config = {
  host: process.env.ACC_HOST ?? '127.0.0.1',
  port: Number(process.env.ACC_PORT ?? 7820),
  dataDir: resolve(process.env.ACC_DATA_DIR ?? join(here, '../data')),
  webDist: resolve(process.env.ACC_WEB_DIST ?? join(here, '../../web/dist')),
  secureCookies: process.env.ACC_SECURE_COOKIES === '1',
  retentionDays: Number(process.env.ACC_RETENTION_DAYS ?? 30),
};

export const dbPath = () => join(config.dataDir, 'acc.db');
