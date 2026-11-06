<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  /** Détail sous la valeur (ex. « sur 4 au total »). */
  hint?: string;
  icon: string;
  tone?: "default" | "ok" | "warn" | "bad";
  to?: string;
}>();

const TONES = {
  default: "bg-blue-100 text-blue-700",
  ok: "bg-green-100 text-green-700",
  warn: "bg-amber-100 text-amber-700",
  bad: "bg-red-100 text-red-700",
} as const;
</script>

<template>
  <component
    :is="to ? 'RouterLink' : 'div'"
    :to="to"
    :class="['flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm', to ? 'transition-shadow hover:shadow-md' : '']"
  >
    <span :class="['flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-xl', TONES[tone ?? 'default']]">
      <FaIcon :icon="['fas', icon]" />
    </span>
    <span class="min-w-0">
      <span class="block text-xs uppercase tracking-wide text-slate-500">{{ label }}</span>
      <span class="block text-2xl font-semibold tabular-nums leading-tight">{{ value }}</span>
      <span v-if="hint" class="block text-xs text-slate-500">{{ hint }}</span>
    </span>
  </component>
</template>
