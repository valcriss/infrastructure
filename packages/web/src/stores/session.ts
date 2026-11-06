import { defineStore } from "pinia";
import { ApiError, api } from "../api";

export const useSession = defineStore("session", {
  state: () => ({
    initialized: null as boolean | null,
    username: null as string | null,
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
    async setup(setupToken: string, username: string, password: string): Promise<void> {
      const r = await api<{ username: string }>("/api/v1/setup", {
        method: "POST",
        body: JSON.stringify({ setupToken, username, password }),
      });
      this.initialized = true;
      this.username = r.username;
    },
    async logout(): Promise<void> {
      await api("/api/v1/session", { method: "DELETE" });
      this.username = null;
    },
  },
});
