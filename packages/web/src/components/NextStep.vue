<script setup lang="ts">
import type { Hint } from "../guide";

// Message qui guide l'utilisateur : ce qui se passe, ce qu'il doit faire ensuite, et où.
defineProps<{ hint: Hint }>();
const emit = defineEmits<{ navigate: [] }>();
const TONE = {
  info: "border-blue-200 bg-blue-50 text-blue-900",
  success: "border-green-300 bg-green-50 text-green-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-red-300 bg-red-50 text-red-900",
} as const;
const ICON = { info: "circle-info", success: "circle-check", warning: "triangle-exclamation", error: "circle-xmark" } as const;
</script>

<template>
  <div role="note" class="flex items-start gap-3 rounded-lg border p-3 text-sm" :class="TONE[hint.tone]">
    <FaIcon :icon="['fas', ICON[hint.tone]]" class="mt-0.5 shrink-0" />
    <div class="min-w-0">
      <p class="font-medium">{{ hint.title }}</p>
      <p class="mt-0.5">{{ hint.text }}</p>
      <RouterLink v-if="hint.to" :to="hint.to" class="mt-1 inline-block font-medium underline" @click="emit('navigate')">{{ hint.action ?? "Ouvrir" }}</RouterLink>
    </div>
  </div>
</template>
