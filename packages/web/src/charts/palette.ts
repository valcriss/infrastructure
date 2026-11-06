import { computed } from "vue";
import { useTheme } from "../stores/theme";

/** Couleurs sémantiques des graphiques et pastilles (même sens partout). */
export const TONE = {
  ok: "#22c55e",
  warn: "#f59e0b",
  bad: "#ef4444",
  info: "#38bdf8",
  muted: "#94a3b8",
  accent: "#3b82f6",
  violet: "#a78bfa",
} as const;

/** Couleurs de texte, de grille et de fond adaptées au thème courant. */
export function useChartColors() {
  const theme = useTheme();
  return computed(() =>
    theme.dark
      ? { text: "#cbd5e1", muted: "#94a3b8", grid: "#334155", surface: "#0f172a", tooltip: "#1e293b", tooltipText: "#e2e8f0" }
      : { text: "#334155", muted: "#64748b", grid: "#e2e8f0", surface: "#ffffff", tooltip: "#ffffff", tooltipText: "#0f172a" },
  );
}
