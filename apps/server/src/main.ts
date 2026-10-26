import { buildApp } from './app.ts';
import { config, dbPath } from './config.ts';
import { openDb } from './db.ts';
import { hasUsers } from './auth.ts';

const db = openDb(dbPath());
const { app, store } = await buildApp({ db, webDist: config.webDist, secureCookies: config.secureCookies, trustProxy: config.trustProxy, logger: true });

if (!hasUsers(db)) app.log.warn('Aucun utilisateur : créez-en un avec « npm run admin -w @acc/server -- set-password <utilisateur> »');

const prune = () => {
  const n = store.prune(config.retentionDays * 24 * 3600 * 1000);
  if (n) app.log.info(`${n} événements de plus de ${config.retentionDays} jours supprimés`);
};
prune();
setInterval(prune, 6 * 3600 * 1000).unref();

await app.listen({ host: config.host, port: config.port });

const shutdown = async () => { await app.close(); db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
