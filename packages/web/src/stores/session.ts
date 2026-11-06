import { defineStore } from "pinia";
import { ApiError, api } from "../api";

export const useSession = defineStore("session", {
  state: () => ({
    initialized: null as boolean | null,
    username: null as string | null,
    /** Faux tant que la clé de restauration n'a pas été générée (ou reprise du dépôt Git). */
    hasRestorationKey: true,
  }),
  actions: {
    async refresh(): Promise<void> {
      const status = await api<{ initialized: boolean }>("/status");
      this.initialized = status.initialized;
      if (!status.initialized) {
        this.username = null;
        return;
      }
      try {
        this.username = (await api<{ username: string }>("/api/v1/session")).username;
        this.hasRestorationKey = (await api<{ recipient: string | null }>("/api/v1/admin/restoration-key")).recipient !== null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) this.username = null;
        else throw err;
      }
    },
    async login(username: string, password: string): Promise<void> {
      const r = await api<{ username: string }>("/api/v1/session", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      this.username = r.username;
    },
    /** Étape 1 de l'assistant : crée le compte administrateur (sans clé de restauration). */
    async setup(setupToken: string, username: string, password: string): Promise<void> {
      const r = await api<{ username: string }>("/api/v1/setup", {
        method: "POST",
        body: JSON.stringify({ setupToken, username, password }),
      });
      this.initialized = true;
      this.username = r.username;
    },
    async changeCredentials(body: {
      currentPassword: string;
      newUsername?: string;
      newPassword?: string;
    }): Promise<void> {
      const r = await api<{ username: string }>("/api/v1/admin/credentials", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      this.username = r.username;
    },
    async logout(): Promise<void> {
      await api("/api/v1/session", { method: "DELETE" });
      this.username = null;
    },
  },
});
