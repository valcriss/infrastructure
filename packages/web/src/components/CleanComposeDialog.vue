<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, describeError } from "../api";
import DiffView from "./DiffView.vue";

// « Nettoyer le contenu » : aperçu avant/après (commentaires et `version` supprimés, lignes vides entre sections et
// services). Rien n'est enregistré : « Appliquer » remplace seulement le brouillon de l'éditeur.
const props = defineProps<{ compose: string }>();
const emit = defineEmits<{ close: []; apply: [compose: string] }>();

interface Result { compose: string; comments: number; versionRemoved: string | null; changed: boolean }
const result = ref<Result | null>(null);
const error = ref("");

onMounted(async () => {
  try {
    result.value = await api<Result>("/api/v1/compose/clean", { method: "POST", body: JSON.stringify({ compose: props.compose }) });
  } catch (err) {
    error.value = describeError(err);
  }
});

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" aria-label="Nettoyer le contenu" class="w-full max-w-4xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <h2 class="text-lg font-semibold">Nettoyer le contenu</h2>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>
      <div class="space-y-3 p-6 text-sm">
        <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>
        <p v-else-if="!result" class="text-slate-500">Calcul de l'aperçu…</p>
        <template v-else>
          <p v-if="!result.changed" class="text-green-700">Ce Compose est déjà propre : rien à nettoyer.</p>
          <template v-else>
            <ul class="list-disc space-y-0.5 pl-5 text-slate-700">
              <li>{{ result.comments }} commentaire(s) supprimé(s)</li>
              <li v-if="result.versionRemoved !== null">directive <code>version: {{ result.versionRemoved }}</code> supprimée (obsolète dans la spécification Compose)</li>
              <li>une ligne vide entre les sections et entre les services</li>
            </ul>
            <p class="text-xs text-slate-500">
              Rouge : retiré ; vert : ajouté. Rien n'est enregistré : le résultat remplace le brouillon, que vous pouvez encore annuler, puis enregistrer comme révision. Les révisions précédentes conservent les commentaires.
            </p>
            <DiffView :before="compose" :after="result.compose" />
          </template>
        </template>
      </div>
      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">{{ result && !result.changed ? "Fermer" : "Annuler" }}</button>
        <button v-if="result?.changed" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700" @click="emit('apply', result.compose)">Appliquer au brouillon</button>
      </footer>
    </div>
  </div>
</template>
