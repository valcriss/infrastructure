<script setup lang="ts">
import { computed } from "vue";
import { diffLines, hasChanges } from "../diff";

const props = defineProps<{ before: string; after: string }>();
const lines = computed(() => diffLines(props.before, props.after));
const changed = computed(() => hasChanges(lines.value));
</script>

<template>
  <p v-if="!changed" class="text-sm text-slate-500">Aucune différence.</p>
  <pre v-else class="max-h-96 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-xs leading-5"><template v-for="(l, i) in lines" :key="i"><span
    :class="l.type === 'add' ? 'block bg-green-100 text-green-900' : l.type === 'del' ? 'block bg-red-100 text-red-900' : 'block text-slate-500'"
  >{{ l.type === "add" ? "+ " : l.type === "del" ? "- " : "  " }}{{ l.text }}</span></template></pre>
</template>
