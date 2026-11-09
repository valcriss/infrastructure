<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, describeError, formatBytes, type MetricsResult } from "../api";
import MetricChart, { type ChartSeries } from "./MetricChart.vue";

// Courbes CPU, mémoire et réseau d'un conteneur, d'après les relevés de l'agent.
const props = defineProps<{ hostId: string; containerId: string; running: boolean; usage: { cpuPercent: number; memBytes: number; memLimitBytes: number } | null }>();

const ranges = [
  { key: "1h", label: "1 h" },
  { key: "6h", label: "6 h" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 j" },
];
const range = ref("1h");
const data = ref<MetricsResult | null>(null);
const error = ref("");
let timer: number | undefined;

async function load() {
  try {
    data.value = await api<MetricsResult>(`/api/v1/hosts/${props.hostId}/containers/${props.containerId}/metrics?${new URLSearchParams({ range: range.value })}`);
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
}

const series = (pick: (p: MetricsResult["containers"][number]["points"][number]) => number | null): ChartSeries[] =>
  (data.value?.containers ?? []).map((c) => ({ label: c.container, points: c.points.map((p) => ({ t: Date.parse(p.t), v: pick(p) })) }));
const cpu = computed(() => series((p) => p.cpu));
const mem = computed(() => series((p) => p.mem));
const rx = computed(() => series((p) => p.rxBps));
const tx = computed(() => series((p) => p.txBps));
const empty = computed(() => data.value !== null && data.value.containers.every((c) => c.points.length === 0));

watch(range, () => void load());
onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 30_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-4">
    <div v-if="usage && running" class="grid grid-cols-3 gap-3 text-sm">
      <div class="rounded-lg border border-slate-200 p-3"><p class="text-xs text-slate-500">CPU</p><p class="text-lg font-semibold tabular-nums">{{ usage.cpuPercent.toFixed(1) }} %</p><p class="text-xs text-slate-500">100 % = un cœur</p></div>
      <div class="rounded-lg border border-slate-200 p-3"><p class="text-xs text-slate-500">Mémoire</p><p class="text-lg font-semibold tabular-nums">{{ formatBytes(usage.memBytes) }}</p></div>
      <div class="rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-500">Limite mémoire</p>
        <p class="text-lg font-semibold tabular-nums">{{ usage.memLimitBytes ? formatBytes(usage.memLimitBytes) : "aucune" }}</p>
        <p v-if="usage.memLimitBytes" class="text-xs text-slate-500">{{ Math.round((usage.memBytes / usage.memLimitBytes) * 100) }} % utilisés</p>
      </div>
    </div>
    <p v-else-if="!running" class="rounded bg-slate-50 p-3 text-sm text-slate-600">Le conteneur n'est pas en marche : pas de mesure en direct. Les courbes ci-dessous montrent sa dernière activité.</p>

    <div role="group" aria-label="Période" class="inline-flex overflow-hidden rounded border border-slate-300 text-sm">
      <button v-for="r in ranges" :key="r.key" class="px-3 py-1.5" :class="range === r.key ? 'bg-blue-600 text-white' : 'bg-white hover:bg-slate-100'" :aria-pressed="range === r.key" @click="range = r.key">{{ r.label }}</button>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="empty" class="text-sm text-slate-500">Aucun relevé sur cette période.</p>
    <div v-else-if="data" class="grid gap-4 md:grid-cols-2">
      <MetricChart title="CPU (100 % = un cœur)" unit="percent" :series="cpu" />
      <MetricChart title="Mémoire utilisée" unit="bytes" :series="mem" />
      <MetricChart title="Réseau reçu" unit="bps" :series="rx" />
      <MetricChart title="Réseau émis" unit="bps" :series="tx" />
    </div>
    <p class="text-xs text-slate-500">Un point toutes les {{ data?.stepSec ?? "…" }} s · collecte toutes les {{ data?.intervalSec ?? "…" }} s · conservé {{ data?.retentionDays ?? "…" }} j. Les débits sont déduits des compteurs réseau cumulés (inconnus après un redémarrage).</p>
  </div>
</template>
