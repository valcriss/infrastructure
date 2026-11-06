<script setup lang="ts">
import { computed } from "vue";
import { formatBytes } from "../api";

export interface ChartSeries {
  label: string;
  points: { t: number; v: number | null }[];
}

const props = defineProps<{
  title: string;
  unit: "percent" | "bytes" | "bps";
  series: ChartSeries[];
}>();

const W = 640;
const H = 150;
const PAD = { l: 8, r: 8, t: 8, b: 8 };
const COLORS = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2"];

function fmt(v: number): string {
  if (props.unit === "percent") return `${v.toFixed(v >= 10 ? 0 : 1)} %`;
  if (props.unit === "bps") return `${formatBytes(v)}/s`;
  return formatBytes(v);
}

const bounds = computed(() => {
  const all = props.series.flatMap((s) => s.points);
  const ts = all.map((p) => p.t);
  const vs = all.map((p) => p.v).filter((v): v is number => v !== null);
  return { t0: Math.min(...ts), t1: Math.max(...ts), max: vs.length ? Math.max(...vs) : 0 };
});

const empty = computed(() => props.series.every((s) => s.points.every((p) => p.v === null)));

/** Une courbe par série ; un trou (valeur inconnue) interrompt le tracé au lieu de l'interpoler. */
const paths = computed(() => {
  const { t0, t1, max } = bounds.value;
  const span = Math.max(1, t1 - t0);
  const top = max <= 0 ? 1 : max * 1.1;
  const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / top) * (H - PAD.t - PAD.b);
  return props.series.map((s, i) => {
    let d = "";
    let pen = false;
    const dots: { cx: number; cy: number }[] = [];
    let run = 0;
    for (const p of s.points) {
      if (p.v === null) {
        pen = false;
        run = 0;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
      run++;
      // Un point isolé (entouré de trous) n'a pas de segment : on le matérialise.
      if (run === 1) dots.push({ cx: x(p.t), cy: y(p.v) });
    }
    const last = [...s.points].reverse().find((p) => p.v !== null)?.v ?? null;
    return { label: s.label, d, dots, color: COLORS[i % COLORS.length] as string, last };
  });
});

const ariaLabel = computed(
  () => `${props.title} : ` + (empty.value ? "pas de données" : paths.value.map((p) => `${p.label} ${p.last === null ? "inconnu" : fmt(p.last)}`).join(", ")),
);
const time = (t: number) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <figure class="rounded-lg border border-slate-200 bg-white p-4">
    <figcaption class="flex items-baseline justify-between text-sm">
      <span class="font-medium">{{ title }}</span>
      <span v-if="!empty" class="text-xs text-slate-500">max {{ fmt(bounds.max) }}</span>
    </figcaption>
    <p v-if="empty" class="mt-6 text-center text-sm text-slate-500">Pas encore de données sur cette période.</p>
    <template v-else>
      <svg :viewBox="`0 0 ${W} ${H}`" class="mt-2 h-36 w-full" role="img" :aria-label="ariaLabel" preserveAspectRatio="none">
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="H - PAD.b" :y2="H - PAD.b" stroke="#e2e8f0" />
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="PAD.t" :y2="PAD.t" stroke="#f1f5f9" />
        <g v-for="p in paths" :key="p.label">
          <path :d="p.d" fill="none" :stroke="p.color" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
          <circle v-for="(d, i) in p.dots" :key="i" :cx="d.cx" :cy="d.cy" r="1.8" :fill="p.color" />
        </g>
      </svg>
      <div class="flex justify-between text-[11px] text-slate-400"><span>{{ time(bounds.t0) }}</span><span>{{ time(bounds.t1) }}</span></div>
      <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <li v-for="p in paths" :key="p.label" class="flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-full" :style="{ background: p.color }" aria-hidden="true"></span>
          {{ p.label }} : <span class="font-medium">{{ p.last === null ? "inconnu" : fmt(p.last) }}</span>
        </li>
      </ul>
    </template>
  </figure>
</template>
