import type { Container, Inventory } from "@infra/shared";
import { request } from "node:http";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** Requête GET en lecture seule vers l'API Docker locale (socket Unix). */
export function dockerGet(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("réponse Docker trop volumineuse"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Docker a répondu ${res.statusCode} pour ${path}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("délai Docker dépassé")));
    req.on("error", reject);
    req.end();
  });
}

interface RawContainer {
  Id?: unknown;
  Names?: unknown;
  Image?: unknown;
  ImageID?: unknown;
  State?: unknown;
  Status?: unknown;
  Created?: unknown;
  Labels?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Transforme la réponse `GET /containers/json` en conteneurs du protocole. */
export function mapContainers(raw: unknown): Container[] {
  if (!Array.isArray(raw)) return [];
  const out: Container[] = [];
  for (const item of raw as RawContainer[]) {
    const id = str(item.Id);
    if (!id) continue;
    const labels =
      item.Labels && typeof item.Labels === "object" ? (item.Labels as Record<string, unknown>) : {};
    const project = str(labels["com.docker.compose.project"]);
    const service = str(labels["com.docker.compose.service"]);
    out.push({
      id,
      names: Array.isArray(item.Names)
        ? item.Names.filter((n): n is string => typeof n === "string").map((n) => n.replace(/^\//, ""))
        : [],
      image: str(item.Image),
      imageId: str(item.ImageID),
      state: str(item.State),
      status: str(item.Status),
      created: typeof item.Created === "number" ? Math.trunc(item.Created) : 0,
      ...(project ? { composeProject: project } : {}),
      ...(service ? { composeService: service } : {}),
    });
  }
  return out;
}

export async function collectInventory(socketPath: string): Promise<Inventory> {
  const [version, containers] = await Promise.all([
    dockerGet(socketPath, "/version"),
    dockerGet(socketPath, "/containers/json?all=1"),
  ]);
  const dockerVersion =
    version && typeof version === "object" ? str((version as { Version?: unknown }).Version) : "";
  return {
    observedAt: new Date().toISOString(),
    dockerVersion: dockerVersion || "inconnue",
    containers: mapContainers(containers),
  };
}
