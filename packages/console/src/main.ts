import { buildApp } from "./app.js";
import { ensureBootstrapToken } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

await migrate(pool, (m) => console.log(m));
const { app, setup } = await buildApp({ config, pool, logger: true });
await ensureBootstrapToken(pool, config.sharedDir);

await app.listen({ host: config.host, port: config.port });

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
