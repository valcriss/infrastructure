<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { formatBytes } from "../api";

// Barre empilée : part de chaque catégorie Docker dans l'espace utilisé (s'étire à l'affichage).
const props = defineProps<{ segments: { label: string; value: number; color: string }[] }>();

const total = computed(() => props.segments.reduce((s, x) => s + x.value, 0));
const ready = ref(false);
onMounted(() => requestAnimationFrame(() => (ready.value = true)));
const width = (v: number): string => (ready.value && total.value > 0 ? `${(v / total.value) * 100}%` : "0%");
</script>

<template>
  <div
    class="flex h-3 overflow-hidden rounded-full bg-slate-100"
    role="img"
    :aria-label="`Répartition de l'espace Docker : ${segments.map((s) => `${s.label} ${formatBytes(s.value)}`).join(', ')}`"
  >
    <div
      v-for="s in segments"
      :key="s.label"
      class="h-full transition-all duration-1000 ease-out"
      :style="{ width: width(s.value), backgroundColor: s.color }"
      :title="`${s.label} : ${formatBytes(s.value)}`"
    ></div>
  </div>
</template>
