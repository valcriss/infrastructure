export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Erreur ${res.status}`, err?.details);
  }
  return data as T;
}

/** Message lisible pour une erreur d'API, avec les erreurs de Compose localisées. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return "Erreur inattendue.";
  if (err.code === "invalid_compose" && Array.isArray(err.details)) {
    return (
      "Compose invalide : " +
      (err.details as { message: string; line?: number }[])
        .map((i) => (i.line ? `ligne ${i.line} — ${i.message}` : i.message))
        .join(" ; ")
    );
  }
  if (err.code === "revision_conflict") {
    return "La stack a été modifiée entre-temps. Rechargez la page pour récupérer la dernière révision.";
  }
  return err.message;
}

export interface Container {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  composeProject?: string;
  composeService?: string;
}

export interface Host {
  id: string;
  name: string;
  agentVersion: string | null;
  capabilities: string[];
  presence: "online" | "offline" | "pending";
  lastSeenAt: string | null;
  dockerVersion: string | null;
  inventoryObservedAt: string | null;
  containerCount: number | null;
}

export interface HostDetail extends Host {
  containers: Container[];
}

export interface StackSummary {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  description: string;
  currentRevision: number;
  deployedRevision: number | null;
  pendingDeploy: boolean;
  deployedAt: string | null;
  updatedAt: string;
  observed: { total: number; running: number; observedAt: string } | null;
}

export interface VariableView {
  name: string;
  value: string | null;
  sensitive: boolean;
}

export interface StackDetail extends StackSummary {
  compose: string;
  variables: VariableView[];
  files: string[];
  containers: Container[];
}

export interface RevisionSummary {
  revision: number;
  digest: string;
  author: string;
  message: string | null;
  createdAt: string;
}

export interface RevisionDetail extends RevisionSummary {
  compose: string;
  variables: VariableView[];
  files: Record<string, string>;
}

export type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "unknown";

export interface OperationView {
  id: string;
  type: "deploy" | "stop" | "start";
  stackId: string;
  revision: number | null;
  status: OperationStatus;
  requestedBy: string;
  error: string | null;
  result: { images?: { service: string; image: string; repoDigests: string[] }[]; services?: { service: string; state: string; health?: string }[] } | null;
  log?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChangeResult {
  revision: number;
  changed: boolean;
  backup: { status: string };
}

export const fmtDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString("fr-FR") : "jamais";

export interface ObservedProject {
  name: string;
  managedStackId: string | null;
  importable: boolean;
  total: number;
  running: number;
  services: { service: string; image: string }[];
}
