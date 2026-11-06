import { defineStore } from "pinia";
import { api, type Dashboard } from "../api";

export type HealthLevel = "unknown" | "ok" | "warning" | "critical";

/** Santé globale affichée dans l'en-tête : la pire gravité parmi les alertes et les agents hors ligne. */
export const useHealth = defineStore("health", {
  state: () => ({ level: "unknown" as HealthLevel, issues: 0, timer: undefined as number | undefined }),
  actions: {
    async refresh(): Promise<void> {
      try {
        const d = await api<Dashboard>("/api/v1/dashboard");
        const critical = d.alerts.filter((a) => a.severity === "critical").length;
        const warning = d.alerts.filter((a) => a.severity === "warning").length;
        this.issues = critical + warning + d.agents.offline;
        this.level = critical > 0 || d.agents.offline > 0 ? "critical" : warning > 0 ? "warning" : "ok";
      } catch {
        this.level = "unknown";
      }
    },
    start(): void {
      if (this.timer !== undefined) return;
      void this.refresh();
      this.timer = window.setInterval(() => void this.refresh(), 30_000);
    },
    stop(): void {
      window.clearInterval(this.timer);
      this.timer = undefined;
      this.level = "unknown";
    },
  },
});
