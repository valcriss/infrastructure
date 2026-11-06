<script setup lang="ts">
import { computed } from "vue";
import BaseChart from "./BaseChart.vue";
import { useChartColors } from "./palette";

export interface DonutItem {
  label: string;
  value: number;
  color: string;
}

const props = defineProps<{ title: string; items: DonutItem[]; centerLabel?: string }>();
const colors = useChartColors();

const total = computed(() => props.items.reduce((s, i) => s + i.value, 0));
const pct = (v: number): string => (total.value ? `${Math.round((v / total.value) * 100)} %` : "0 %");

const option = computed(() => ({
  animationDuration: 900,
  animationEasing: "cubicOut",
  animationType: "expansion",
  tooltip: {
    trigger: "item",
    backgroundColor: colors.value.tooltip,
    borderColor: colors.value.grid,
    textStyle: { color: colors.value.tooltipText },
    formatter: (p: { name: string; value: number; percent: number }) => `${p.name} : <b>${p.value}</b> (${Math.round(p.percent)} %)`,
  },
  series: [
    {
      type: "pie",
      radius: ["62%", "86%"],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: colors.value.surface, borderWidth: 3 },
      label: {
        show: true,
        position: "center",
        formatter: () => `{v|${total.value}}\n{l|${props.centerLabel ?? ""}}`,
        rich: {
          v: { fontSize: 26, fontWeight: 600, color: colors.value.text, lineHeight: 30 },
          l: { fontSize: 11, color: colors.value.muted },
        },
      },
      emphasis: { scaleSize: 4, label: { show: true } },
      labelLine: { show: false },
      data: props.items.filter((i) => i.value > 0).map((i) => ({ name: i.label, value: i.value, itemStyle: { color: i.color } })),
    },
  ],
}));
</script>

<template>
  <div class="flex flex-col items-center gap-4 sm:flex-row">
    <div class="w-44 shrink-0">
      <BaseChart :option="option" :height="176" :label="`${title} : ${items.map((i) => `${i.value} ${i.label}`).join(', ')}`" />
    </div>
    <ul class="w-full space-y-1.5 text-sm">
      <li v-for="i in items" :key="i.label" class="flex items-center gap-2">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: i.color }"></span>
        <span class="flex-1 text-slate-600">{{ i.label }}</span>
        <span class="font-medium tabular-nums">{{ i.value }}</span>
        <span class="w-10 text-right text-xs tabular-nums text-slate-500">{{ pct(i.value) }}</span>
      </li>
    </ul>
  </div>
</template>
