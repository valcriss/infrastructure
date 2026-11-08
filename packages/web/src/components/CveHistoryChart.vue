<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, fmtDate } from "../api";
import BaseChart from "../charts/BaseChart.vue";
import { TONE, useChartColors } from "../charts/palette";

// Évolution du nombre de CVE par gravité (aires empilées), pour l'ensemble du tableau de bord, une application ou un de ses services.
const props = defineProps<{
  hostId?: string;
  stackId?: string;
  /** Projet Compose observé (avec hostId). */
  project?: string;
  /** Services proposés dans la liste (application) ; vide : pas de choix. */
  services?: string[];
  /** « filtered » : seuil de gravité des paramètres ; « all » : toutes les gravités. */
  mode?: "filtered" | "all";
  height?: number;
}>();

interface Point { t: string; critical: number; high: number; medium: number; low: number; unknown: number }
interface History { days: number; stepSec: number; firstScanAt: string | null; points: Point[] }

const DAYS = [7, 30, 90] as const;
const days = ref<(typeof DAYS)[number]>(30);
const service = ref("");
const data = ref<History | null>(null);
const error = ref("");
const colors = useChartColors();
let timer: number | undefined;
let seq = 0;

async function load() {
  const my = ++seq;
  const q = new URLSearchParams({ days: String(days.value), mode: props.mode ?? "filtered" });
  if (props.hostId) q.set("hostId", props.hostId);
  if (props.stackId) q.set("stackId", props.stackId);
  if (props.project) q.set("project", props.project);
  if (service.value) q.set("service", service.value);
  try {
    const r = await api<History>(`/api/v1/dashboard/cve-history?${q}`);
    if (my !== seq) return;
    data.value = r;
    error.value = "";
  } catch {
    if (my === seq) error.value = "Historique indisponible.";
  }
}
watch([days, service, () => props.mode, () => props.hostId, () => props.stackId, () => props.project], () => void load());
// Un changement d'application remet le choix du service à zéro.
watch([() => props.stackId, () => props.project], () => (service.value = ""));
onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 5 * 60_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const SEVERITIES = [
  { key: "critical", name: "Critiques", color: TONE.bad },
  { key: "high", name: "Élevées", color: "#f97316" },
  { key: "medium", name: "Moyennes", color: "#fbbf24" },
  { key: "low", name: "Faibles", color: "#0ea5e9" },
  { key: "unknown", name: "Inconnues", color: TONE.muted },
] as const;

const hasData = computed(() => !!data.value?.firstScanAt && data.value.points.some((p) => p.critical + p.high + p.medium + p.low + p.unknown > 0));
const last = computed(() => data.value?.points[data.value.points.length - 1] ?? null);

const option = computed(() => {
  const pts = data.value?.points ?? [];
  const shortDate = (t: number) => new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", ...(days.value <= 7 ? { hour: "2-digit", minute: "2-digit" } : {}) });
  return {
    animationDuration: 900,
    grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: colors.value.tooltip,
      borderColor: colors.value.grid,
      textStyle: { color: colors.value.tooltipText },
      formatter: (params: { axisValue: number; marker: string; seriesName: string; value: [number, number] }[]) =>
        `${shortDate(params[0]?.axisValue ?? 0)}<br/>` + params.map((p) => `${p.marker} ${p.seriesName} : <b>${p.value[1]}</b>`).join("<br/>"),
    },
    xAxis: { type: "time", axisLine: { lineStyle: { color: colors.value.grid } }, axisLabel: { color: colors.value.muted, hideOverlap: true }, splitLine: { show: false } },
    yAxis: { type: "value", min: 0, axisLabel: { color: colors.value.muted }, splitLine: { lineStyle: { color: colors.value.grid, type: "dashed" } } },
    series: SEVERITIES.map((s) => ({
      name: s.name,
      type: "line",
      stack: "cve",
      smooth: false,
      showSymbol: false,
      lineStyle: { width: 1, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: { color: s.color, opacity: 0.55 },
      data: pts.map((p) => [Date.parse(p.t), p[s.key]]),
    })),
  };
});
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <label v-if="services && services.length > 1" class="flex items-center gap-1">
        <span class="text-slate-500">Service</span>
        <select v-model="service" class="rounded border border-slate-300 bg-white px-2 py-1" aria-label="Service">
          <option value="">Toute l'application</option>
          <option v-for="s in services" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <span v-else />
      <div role="group" aria-label="Période de l'historique" class="inline-flex overflow-hidden rounded-md border border-slate-300">
        <button v-for="d in DAYS" :key="d" :aria-pressed="days === d" :class="['px-2 py-1', days === d ? 'bg-blue-600 text-white' : 'hover:bg-slate-100']" @click="days = d">{{ d }} j</button>
      </div>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <BaseChart v-if="hasData" :option="option" :height="height ?? 220" label="Courbe : évolution du nombre de CVE par gravité" />
    <p v-else-if="data" class="flex items-center justify-center text-center text-sm text-slate-500" :style="{ height: `${height ?? 220}px` }">
      {{ data.firstScanAt ? "Aucune CVE sur cette période." : "Pas encore de scan réussi : l'historique commence au premier scan." }}
    </p>
    <p v-else-if="!error" class="text-sm text-slate-500">Chargement…</p>
    <p v-if="hasData && last" class="mt-1 text-xs text-slate-500">
      Maintenant : {{ last.critical }} critique(s), {{ last.high }} élevée(s)<template v-if="last.medium + last.low + last.unknown > 0">, {{ last.medium + last.low + last.unknown }} autre(s)</template>.
      Historique depuis le premier scan ({{ fmtDate(data?.firstScanAt ?? "") }}) ; images actuelles, risques acceptés non retranchés.
    </p>
  </div>
</template>
