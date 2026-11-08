<script setup lang="ts">
import type { EChartsCoreOption } from "echarts/core";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

// Enveloppe ECharts : chargement à la demande, redimensionnement automatique et animation d'apparition.
const props = defineProps<{ option: object; label: string; height?: number }>();
const asOption = (o: object): EChartsCoreOption => o as EChartsCoreOption;

const el = ref<HTMLElement | null>(null);
const failed = ref(false);
let chart: { setOption(o: EChartsCoreOption, notMerge?: boolean): void; resize(): void; dispose(): void } | null = null;
let observer: ResizeObserver | null = null;

onMounted(async () => {
  try {
    const { echarts } = await import("./echarts");
    if (!el.value) return;
    chart = echarts.init(el.value, undefined, { renderer: "canvas" });
    chart.setOption(asOption(props.option));
    observer = new ResizeObserver(() => chart?.resize());
    observer.observe(el.value);
  } catch {
    failed.value = true;
  }
});

watch(
  () => props.option,
  (o) => chart?.setOption(asOption(o), true),
  { deep: true },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div role="img" :aria-label="label" class="w-full" :style="{ height: `${height ?? 220}px` }">
    <p v-if="failed" class="text-sm text-slate-500">Graphique indisponible.</p>
    <div v-else ref="el" class="h-full w-full"></div>
  </div>
</template>
