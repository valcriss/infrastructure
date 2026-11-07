<script setup lang="ts">
import { computed } from "vue";
import type { ScanStateName } from "../api";

export interface Counts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown?: number;
}

// Un badge par gravité, jamais pour un compteur à zéro. « Sain » seulement si un scan a abouti sans résultat.
const props = defineProps<{ state: ScanStateName; counts: Counts | null; stale?: boolean; hidden?: number; position?: number | null }>();

const LEVELS = [
  { key: "critical", label: "Critiques", short: "C", cls: "bg-red-600 text-white" },
  { key: "high", label: "Élevées", short: "H", cls: "bg-orange-500 text-white" },
  { key: "medium", label: "Moyennes", short: "M", cls: "bg-amber-400 text-amber-950" },
  { key: "low", label: "Faibles", short: "L", cls: "bg-sky-500 text-white" },
] as const;

const shown = computed(() => LEVELS.filter((l) => (props.counts?.[l.key] ?? 0) > 0));
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1 text-xs">
    <template v-if="counts && shown.length > 0">
      <span v-for="l in shown" :key="l.key" :class="['inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold tabular-nums', l.cls]" :title="`${counts[l.key]} vulnérabilité(s) ${l.label.toLowerCase()}`">
        {{ l.short }} {{ counts[l.key] }}
      </span>
    </template>
    <span v-else-if="state === 'clean'" class="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-green-800">
      <FaIcon :icon="['fas', 'circle-check']" /> {{ hidden ? "Sain au seuil choisi" : "Sain" }}
    </span>
    <span v-else-if="state === 'never'" class="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700">Jamais scannée</span>
    <span v-if="state === 'failed'" class="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800"><FaIcon :icon="['fas', 'triangle-exclamation']" /> Scan en échec</span>
    <span v-else-if="state === 'pending'" class="inline-flex items-center gap-1 rounded bg-slate-200 px-1.5 py-0.5 text-slate-700" title="Les scans s'exécutent un à la fois"><FaIcon :icon="['fas', 'clock']" /> En attente<template v-if="position"> · n° {{ position }}</template></span>
    <span v-else-if="state === 'running'" class="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-blue-800"><FaIcon :icon="['fas', 'arrows-rotate']" spin /> Scan en cours</span>
    <span v-if="stale" class="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600" title="Le dernier scan est ancien">périmé</span>
  </span>
</template>
