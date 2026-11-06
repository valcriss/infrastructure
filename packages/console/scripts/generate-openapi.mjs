// Régénère docs/openapi.json à partir du code (après `npm run build -w @infra/console`).
import { writeFileSync } from "node:fs";
import { buildOpenApi } from "../dist/openapi.js";

const target = new URL("../../../docs/openapi.json", import.meta.url);
writeFileSync(target, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log("docs/openapi.json régénéré");
