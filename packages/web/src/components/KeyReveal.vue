<script setup lang="ts">
import { ref } from "vue";
import { ApiError, api } from "../api";

const emit = defineEmits<{ done: [] }>();

const restorationKey = ref("");
const recipient = ref("");
const saved = ref(false);
const error = ref("");
const busy = ref(false);

async function generate() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<{ restorationKey: string; recipient: string }>("/api/v1/admin/restoration-key", { method: "POST" });
    restorationKey.value = r.restorationKey;
    recipient.value = r.recipient;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Génération impossible.";
  } finally {
    busy.value = false;
  }
}

function download() {
  const blob = new Blob(
    [`# Clé de restauration — à conserver hors de la console et hors du dépôt Git\n# Clé publique : ${recipient.value}\n${restorationKey.value}\n`],
    { type: "text/plain" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "cle-de-restauration.txt";
  a.click();
  URL.revokeObjectURL(a.href);
}

function finish() {
  // La clé privée disparaît de la mémoire de la page dès qu'elle est confirmée.
  restorationKey.value = "";
  emit("done");
}
</script>

<template>
  <section class="rounded-lg border border-amber-300 bg-amber-50 p-6">
    <h2 class="text-lg font-semibold">Clé de restauration</h2>
    <p class="mt-2 text-sm text-slate-700">
      Cette clé chiffre les secrets sauvegardés dans Git. <strong>Elle n'est affichée qu'une seule fois</strong> et n'est pas conservée par la console.
      Sans elle, les secrets sauvegardés sont irrécupérables. Conservez-la dans un gestionnaire de mots de passe, séparément du dépôt Git.
    </p>
    <template v-if="!restorationKey">
      <button :disabled="busy" class="mt-4 rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50" @click="generate">
        Générer la clé de restauration
      </button>
    </template>
    <template v-else>
      <code class="mt-4 block break-all rounded bg-white px-3 py-2 font-mono text-xs">{{ restorationKey }}</code>
      <button type="button" class="mt-3 rounded border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100" @click="download">Télécharger</button>
      <label class="mt-4 flex items-center gap-2 text-sm">
        <input v-model="saved" type="checkbox" />
        J'ai sauvegardé cette clé en lieu sûr.
      </label>
      <button :disabled="!saved" class="mt-4 w-full rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="finish">Continuer</button>
    </template>
    <p v-if="error" role="alert" class="mt-3 text-sm text-red-700">{{ error }}</p>
  </section>
</template>
