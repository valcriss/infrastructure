<script setup lang="ts" generic="T extends string | number">
// Petit sélecteur segmenté (période, mode…) pour une carte.
defineProps<{ options: { value: T; label: string }[]; label: string }>();
const model = defineModel<T>({ required: true });
</script>

<template>
  <div role="group" :aria-label="label" class="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-300 text-xs">
    <button v-for="o in options" :key="String(o.value)" :aria-pressed="model === o.value" :class="['px-2 py-1', model === o.value ? 'bg-blue-600 text-white' : 'hover:bg-slate-100']" @click="model = o.value">{{ o.label }}</button>
  </div>
</template>
