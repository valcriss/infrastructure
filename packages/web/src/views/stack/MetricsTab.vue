<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, describeError, type Container, type MetricsResult, type ProjectRef } from "../../api";
import MetricChart, { type ChartSeries } from "../../components/MetricChart.vue";

const props = defineProps<{ stack: { id: string; containers: Container[]; hostPresence: "online" | "offline" }; project?: ProjectRef }>();

const ranges = [
  { key: "1h", label: "1 h" },
  { key: "6h", label: "6 h" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 j" },
];
const range = ref("1h");
const service = ref("");
const data = ref<MetricsResult | null>(null);
const error = ref("");
let timer: number | undefined;

const services = computed(() => [...new Set(props.stack.containers.map((c) => c.composeService).filter((s): s is string => !!s))].sort());

async function load() {
  try {
    const q = new URLSearchParams({ range: range.value, ...(service.value ? { service: service.value } : {}) });
    const base = props.project ? `/api/v1/hosts/${props.project.hostId}/projects/${encodeURIComponent(props.project.name)}` : `/api/v1/stacks/${props.stack.id}`;
    data.value = await api<MetricsResult>(`${base}/metrics?${q}`);
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
}

const series = (pick: (p: MetricsResult["containers"][number]["points"][number]) => number | null): ChartSeries[] =>
  (data.value?.containers ?? []).map((c) => ({
    label: c.service ?? c.container,
    points: c.points.map((p) => ({ t: Date.parse(p.t), v: pick(p) })),
  }));

const cpu = computed(() => series((p) => p.cpu));
const mem = computed(() => series((p) => p.mem));
const rx = computed(() => series((p) => p.rxBps));
const tx = computed(() => series((p) => p.txBps));

watch([range, service], () => void load());
onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 30_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-end gap-3 text-sm">
      <div role="group" aria-label="Période" class="flex overflow-hidden rounded border border-slate-300">
        <button
          v-for="r in ranges"
          :key="r.key"
          class="px-3 py-1.5"
          :class="range === r.key ? 'bg-blue-600 text-white' : 'bg-white hover:bg-slate-100'"
          :aria-pressed="range === r.key"
          @click="range = r.key"
        >
          {{ r.label }}
        </button>
      </div>
      <label class="block">
        <span class="sr-only">Service</span>
        <select v-model="service" aria-label="Service" class="rounded border border-slate-300 px-3 py-1.5">
          <option value="">Tous les services</option>
          <option v-for="s in services" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <span v-if="data" class="text-xs text-slate-500">
        Un point toutes les {{ data.stepSec }} s · collecte toutes les {{ data.intervalSec }} s · conservé {{ data.retentionDays }} j
      </span>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="stack.hostPresence === 'offline'" class="rounded bg-amber-50 p-3 text-sm text-amber-800">
      Agent hors ligne : les courbes s'arrêtent à la dernière collecte, rien n'est extrapolé.
    </p>
    <div v-if="data" class="grid gap-4 md:grid-cols-2">
      <MetricChart title="CPU (100 % = un cœur)" unit="percent" :series="cpu" />
      <MetricChart title="Mémoire utilisée" unit="bytes" :series="mem" />
      <MetricChart title="Réseau reçu" unit="bps" :series="rx" />
      <MetricChart title="Réseau émis" unit="bps" :series="tx" />
    </div>
    <p class="text-xs text-slate-500">
      Valeurs relevées par l'agent via l'API Docker. La mémoire exclut le cache de pages inactif ; les débits sont déduits des compteurs réseau cumulés (inconnus après un redémarrage du conteneur).
    </p>
  </div>
</template>
