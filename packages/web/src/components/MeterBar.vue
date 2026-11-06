<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{ label: string; percent: number | null; detail?: string; icon?: string }>();

const value = computed(() => (props.percent === null ? 0 : Math.min(100, Math.max(0, props.percent))));
// La barre part de 0 puis s'étire à l'affichage (animation d'apparition), et suit ensuite les changements.
const shown = ref(0);
onMounted(() => requestAnimationFrame(() => (shown.value = value.value)));
watch(value, (v) => (shown.value = v));

const color = computed(() => (value.value >= 90 ? "bg-red-500" : value.value >= 75 ? "bg-amber-500" : "bg-blue-500"));
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between text-xs">
      <span class="flex items-center gap-1.5 text-slate-600"><FaIcon v-if="icon" :icon="['fas', icon]" class="text-slate-400" />{{ label }}</span>
      <span class="tabular-nums text-slate-500">
        <template v-if="percent !== null">{{ Math.round(percent) }} %</template>
        <template v-else>inconnu</template>
        <template v-if="detail"> · {{ detail }}</template>
      </span>
    </div>
    <div class="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" :aria-label="label" :aria-valuenow="percent === null ? undefined : Math.round(value)" aria-valuemin="0" aria-valuemax="100">
      <div :class="['h-full rounded-full transition-all duration-1000 ease-out', color]" :style="{ width: `${shown}%` }"></div>
    </div>
  </div>
</template>
