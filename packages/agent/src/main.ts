import { AgentClient } from "./client.js";
import { loadConfig } from "./config.js";

const client = new AgentClient(loadConfig());

process.on("SIGTERM", () => client.stop());
process.on("SIGINT", () => client.stop());

await client.run();
