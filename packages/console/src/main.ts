import { buildApp } from "./app.js";
import { ensureBootstrapToken } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { loadOrCreateMasterKey } from "./secretbox.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

await migrate(pool, (m) => console.log(m));
const masterKey = await loadOrCreateMasterKey(config.dataDir);
const { app, setup, ops, backup, metrics, scans, candidates, pruning, watcher, observedWatcher, storage } = await buildApp({ config, pool, logger: true, masterKey });
// Une opération active avant le redémarrage a un résultat inconnu : jamais rejouée.
await ops.markInterruptedUnknown();
await ensureBootstrapToken(pool, config.sharedDir);

await app.listen({ host: config.host, port: config.port });
// Boucle de sauvegarde Git : démarre une fois le serveur à l'écoute.
await backup.start();
// Purge régulière des métriques au-delà de la rétention configurée.
metrics.start();
// Scans de vulnérabilités et vérification des versions d'images (planifiés).
await scans.markInterrupted();
await pruning.markInterrupted();
scans.start();
candidates.start();
watcher.start();
observedWatcher.start();
storage.start();

if (setup.token) {
  // Le secret n'est jamais exposé par l'API : il faut avoir accès aux logs locaux.
  app.log.warn(`Console non initialisée. Secret d'initialisation : ${setup.token}`);
}

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
