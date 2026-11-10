<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { LogEntry } from "../log-entries";

// Affichage des lignes de log avec leurs couleurs (codes ANSI interprétés). Le texte est inséré comme du texte :
// un log ne peut pas injecter de HTML. Suit la fin du flux quand `follow` est actif.
const props = defineProps<{ entries: LogEntry[]; follow: boolean; label: string; empty: string }>();

const box = ref<HTMLElement | null>(null);
watch(
  () => props.entries,
  () => {
    if (props.follow) void nextTick(() => box.value && (box.value.scrollTop = box.value.scrollHeight));
  },
);
</script>

<template>
  <!-- « log » sans annonce vocale : un flux rapide submergerait un lecteur d'écran. -->
  <div
    ref="box"
    role="log"
    aria-live="off"
    tabindex="0"
    :aria-label="label"
    class="overflow-auto whitespace-pre-wrap break-all rounded bg-[#0b1220] p-3 font-mono text-xs leading-5 text-[#e2e8f0]"
  >
    <template v-if="entries.length > 0">
      <div v-for="e in entries" :key="e.id" class="min-h-5"><span v-for="(s, i) in e.segments" :key="i" :style="s.css">{{ s.text }}</span></div>
    </template>
    <template v-else>{{ empty }}</template>
  </div>
</template>
