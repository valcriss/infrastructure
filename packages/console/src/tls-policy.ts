import { isIP } from "node:net";

export function parseTlsSkipVerifyHosts(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(",").map((entry) => {
    const value = entry.trim().toLowerCase();
    const host = value.startsWith(".") ? value.slice(1) : value;
    const labels = host.split(".");
    if (!host || host.length > 253 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || (value.startsWith(".") && (labels.length < 2 || isIP(host)))) {
      throw new Error("TLS_SKIP_VERIFY_HOSTS : hôte invalide (nom seul ou .domaine, sans protocole, port ni joker).");
    }
    return value;
  }))];
}

export function skipsTlsVerification(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return hosts.some((entry) => entry.startsWith(".")
    ? host === entry.slice(1) || host.endsWith(entry)
    : host === entry);
}
