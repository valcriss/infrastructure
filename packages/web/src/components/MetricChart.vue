<script setup lang="ts">
import { computed } from "vue";
import { formatBytes } from "../api";
import AreaChart, { type AreaSeries } from "../charts/AreaChart.vue";

export interface ChartSeries {
  label: string;
  points: { t: number; v: number | null }[];
}

// Courbes de métriques (une par conteneur ou par service) : tracé ECharts avec infobulle qui donne la valeur de
// chaque série à l'instant survolé. Une valeur inconnue interrompt le tracé au lieu d'être interpolée.
const props = defineProps<{
  title: string;
  unit: "percent" | "bytes" | "bps";
  series: ChartSeries[];
}>();

const COLORS = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2"];

function fmt(v: number): string {
  if (props.unit === "percent") return `${v.toFixed(v >= 10 ? 0 : 1)} %`;
  if (props.unit === "bps") return `${formatBytes(v)}/s`;
  return formatBytes(v);
}

const areaSeries = computed<AreaSeries[]>(() => props.series.map((s, i) => ({ name: s.label, color: COLORS[i % COLORS.length] as string, points: s.points })));
const empty = computed(() => props.series.every((s) => s.points.every((p) => p.v === null)));
const max = computed(() => Math.max(0, ...props.series.flatMap((s) => s.points.map((p) => p.v ?? 0))));
const legend = computed(() =>
  props.series.map((s, i) => ({ label: s.label, color: COLORS[i % COLORS.length] as string, last: [...s.points].reverse().find((p) => p.v !== null)?.v ?? null })),
);
</script>

<template>
  <figure class="rounded-lg border border-slate-200 bg-white p-4">
    <figcaption class="flex items-baseline justify-between text-sm">
      <span class="font-medium">{{ title }}</span>
      <span v-if="!empty" class="text-xs text-slate-500">max {{ fmt(max) }}</span>
    </figcaption>
    <p v-if="empty" class="mt-6 text-center text-sm text-slate-500">Pas encore de données sur cette période.</p>
    <template v-else>
      <AreaChart class="mt-2" :title="title" :unit="unit" :series="areaSeries" :height="170" />
      <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <li v-for="p in legend" :key="p.label" class="flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-full" :style="{ background: p.color }" aria-hidden="true"></span>
          {{ p.label }} : <span class="font-medium">{{ p.last === null ? "inconnu" : fmt(p.last) }}</span>
        </li>
      </ul>
    </template>
  </figure>
</template>
