import { defineStore } from "pinia";

export type ThemeMode = "auto" | "light" | "dark";
const KEY = "console.theme";

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    /* stockage indisponible : thème automatique */
  }
  return "auto";
}

const prefersDark = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;

export const useTheme = defineStore("theme", {
  state: () => ({ mode: stored() as ThemeMode, dark: false }),
  actions: {
    /** Applique le thème courant et suit le réglage du système en mode automatique. */
    init(): void {
      this.apply();
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.mode === "auto" && this.apply());
    },
    set(mode: ThemeMode): void {
      this.mode = mode;
      try {
        localStorage.setItem(KEY, mode);
      } catch {
        /* le choix reste valable pour cette session */
      }
      this.apply();
    },
    apply(): void {
      this.dark = this.mode === "dark" || (this.mode === "auto" && prefersDark());
      document.documentElement.classList.toggle("dark", this.dark);
    },
  },
});
