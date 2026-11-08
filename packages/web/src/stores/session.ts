import { startAuthentication } from "@simplewebauthn/browser";
import { defineStore } from "pinia";
import { ApiError, api, type Role, type SessionInfo } from "../api";

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export const useSession = defineStore("session", {
  state: () => ({
    initialized: null as boolean | null,
    username: null as string | null,
    /** Droits et état du compte connecté ; null quand personne n'est connecté. */
    info: null as SessionInfo | null,
    /** Les clés d'accès sont-elles configurées côté console ? (connu avant la connexion) */
    passkeysAvailable: false,
    /** Faux tant que la clé de restauration n'a pas été générée (ou reprise du dépôt Git). */
    hasRestorationKey: true,
  }),
  getters: {
    role: (s): Role | null => s.info?.role ?? null,
    /** Peut déployer, modifier la configuration, lancer des scans. */
    canOperate: (s): boolean => (s.info ? RANK[s.info.role] >= RANK.operator : false),
    isAdmin: (s): boolean => s.info?.role === "admin",
  },
  actions: {
    async refresh(): Promise<void> {
      const status = await api<{ initialized: boolean; passkeys?: boolean }>("/status");
      this.initialized = status.initialized;
      this.passkeysAvailable = status.passkeys ?? false;
      if (!status.initialized) {
        this.username = null;
        this.info = null;
        return;
      }
      try {
        this.info = await api<SessionInfo>("/api/v1/session");
        this.username = this.info.username;
        // La clé de restauration ne concerne que les administrateurs (et pas un compte au mot de passe provisoire).
        if (this.info.role === "admin" && !this.info.mustChangePassword) {
          this.hasRestorationKey = (await api<{ recipient: string | null }>("/api/v1/admin/restoration-key")).recipient !== null;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          this.username = null;
          this.info = null;
        } else throw err;
      }
    },
    /** `code` : code à usage unique ou de secours, si la console l'a demandé (erreur « mfa_required »). */
    async login(username: string, password: string, code?: string): Promise<void> {
      await api("/api/v1/session", { method: "POST", body: JSON.stringify({ username, password, ...(code ? { code } : {}) }) });
      await this.refresh();
    },
    /** Connexion par clé d'accès : l'e-mail reste obligatoire, aucun mot de passe n'est demandé. */
    async loginWithPasskey(email: string): Promise<void> {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
        "/api/v1/session/passkey/options",
        { method: "POST", body: JSON.stringify({ email }) },
      );
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/v1/session/passkey", { method: "POST", body: JSON.stringify({ challengeId, response }) });
      await this.refresh();
    },
    /** Étape 1 de l'assistant : crée le compte administrateur (sans clé de restauration). */
    async setup(setupToken: string, username: string, password: string): Promise<void> {
      await api("/api/v1/setup", { method: "POST", body: JSON.stringify({ setupToken, username, password }) });
      this.initialized = true;
      await this.refresh();
    },
    async changeCredentials(body: { currentPassword: string; newEmail?: string; newPassword?: string }): Promise<void> {
      await api("/api/v1/admin/credentials", { method: "PUT", body: JSON.stringify(body) });
      await this.refresh();
    },
    /** Confirme l'identité avec un code à usage unique (ou de secours) avant une action sensible. */
    async stepUpWithCode(code: string): Promise<void> {
      await api("/api/v1/me/step-up", { method: "POST", body: JSON.stringify({ code }) });
      await this.refresh();
    },
    /** Même confirmation, avec une clé d'accès. */
    async stepUpWithPasskey(): Promise<void> {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/v1/me/step-up/passkey/options", { method: "POST" });
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/v1/me/step-up/passkey", { method: "POST", body: JSON.stringify({ challengeId, response }) });
      await this.refresh();
    },
    async logout(): Promise<void> {
      await api("/api/v1/session", { method: "DELETE" });
      this.username = null;
      this.info = null;
    },
  },
});
