export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Erreur ${res.status}`);
  }
  return data as T;
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
