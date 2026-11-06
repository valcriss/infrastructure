<script setup lang="ts">
import { computed } from "vue";
import { formatBytes } from "../api";
import BaseChart from "./BaseChart.vue";
import { useChartColors } from "./palette";

export interface AreaSeries {
  name: string;
  color: string;
  /** Un point par instant ; une valeur absente (null) crée un trou, jamais interpolé. */
  points: { t: number; v: number | null }[];
}

const props = defineProps<{
  title: string;
  unit: "percent" | "cores" | "bytes" | "bps";
  series: AreaSeries[];
  /** Borne haute fixe de l'axe (ex. 100 pour des pourcentages). */
  max?: number;
  height?: number;
}>();
const colors = useChartColors();

function fmt(v: number): string {
  if (props.unit === "percent") return `${v.toFixed(v >= 10 ? 0 : 1)} %`;
  if (props.unit === "cores") return `${(v / 100).toFixed(2)} cœur(s)`;
  if (props.unit === "bps") return `${formatBytes(v)}/s`;
  return formatBytes(v);
}

const empty = computed(() => props.series.every((s) => s.points.every((p) => p.v === null)));

const option = computed(() => ({
  animationDuration: 1100,
  animationEasing: "cubicOut",
  grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
  tooltip: {
    trigger: "axis",
    backgroundColor: colors.value.tooltip,
    borderColor: colors.value.grid,
    textStyle: { color: colors.value.tooltipText },
    formatter: (params: { axisValue: number; marker: string; seriesName: string; value: [number, number | null] }[]) =>
      `${new Date(params[0]?.axisValue ?? 0).toLocaleString("fr-FR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}<br/>` +
      params.map((p) => `${p.marker} ${p.seriesName} : <b>${p.value[1] === null ? "inconnu" : fmt(p.value[1])}</b>`).join("<br/>"),
  },
  xAxis: {
    type: "time",
    axisLine: { lineStyle: { color: colors.value.grid } },
    axisLabel: { color: colors.value.muted, hideOverlap: true },
    splitLine: { show: false },
  },
  yAxis: {
    type: "value",
    min: 0,
    ...(props.max !== undefined ? { max: props.max } : {}),
    axisLabel: { color: colors.value.muted, formatter: (v: number) => fmt(v) },
    splitLine: { lineStyle: { color: colors.value.grid, type: "dashed" } },
  },
  series: props.series.map((s) => ({
    name: s.name,
    type: "line",
    smooth: 0.25,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 2, color: s.color },
    itemStyle: { color: s.color },
    areaStyle: {
      color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${s.color}66` }, { offset: 1, color: `${s.color}05` }] },
    },
    data: s.points.map((p) => [p.t, p.v]),
  })),
}));
</script>

<template>
  <div>
    <BaseChart v-if="!empty" :option="option" :height="height ?? 220" :label="`Courbe : ${title}`" />
    <p v-else class="flex items-center justify-center text-sm text-slate-500" :style="{ height: `${height ?? 220}px` }">
      Aucune mesure sur cette période.
    </p>
  </div>
</template>
