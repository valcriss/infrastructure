<script setup lang="ts">
import { computed } from "vue";
import type { StackImageComponent } from "../api";

// État de mise à jour d'un service, d'un coup d'œil (en-tête de carte).
const props = defineProps<{ check: StackImageComponent["check"] }>();

const badge = computed<{ text: string; cls: string }>(() => {
  const c = props.check;
  if (!c) return { text: "Non vérifiée", cls: "bg-slate-100 text-slate-600" };
  if (c.status === "error") return { text: "Vérification en échec", cls: "bg-red-100 text-red-800" };
  switch (c.kind) {
    case "up_to_date": return { text: "À jour", cls: "bg-green-100 text-green-800" };
    case "update_available": return { text: "Mise à jour disponible", cls: "bg-amber-100 text-amber-800" };
    case "pinned": return { text: "Épinglée", cls: "bg-slate-100 text-slate-600" };
    case "local": return { text: "Image locale", cls: "bg-slate-100 text-slate-600" };
    default: return { text: "Inconnu", cls: "bg-slate-100 text-slate-600" };
  }
});
</script>

<template>
  <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="badge.cls">{{ badge.text }}</span>
</template>
