<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

// Copie un texte (chemin, commande…) dans le presse-papiers et confirme brièvement.
const props = defineProps<{ text: string; label?: string }>();
const done = ref(false);
let timer: number | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    done.value = true;
  } catch {
    done.value = false;
    window.prompt("Copiez ce texte :", props.text);
    return;
  }
  window.clearTimeout(timer);
  timer = window.setTimeout(() => (done.value = false), 1500);
}
onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <button type="button" class="ml-2 rounded border border-slate-300 px-1.5 py-0.5 text-xs hover:bg-slate-100" :aria-label="label ?? 'Copier'" @click="copy">
    {{ done ? "Copié" : "Copier" }}
  </button>
</template>
