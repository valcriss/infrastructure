<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, describeError } from "../api";
import { useSession } from "../stores/session";
import PanelCard from "./PanelCard.vue";

// Vérification de démarrage (facultative) des images corrigées : une commande par image, lancée dans un conteneur jetable isolé.
interface Check { image: string; command: string[]; expectExit: number; outputContains: string | null }
interface Row { image: string; command: string; expectExit: number; outputContains: string }

const session = useSession();
const rows = ref<Row[]>([]);
const error = ref("");
const info = ref("");
const busy = ref(false);
const canEdit = computed(() => session.isAdmin);

const toRow = (c: Check): Row => ({ image: c.image, command: c.command.join("\n"), expectExit: c.expectExit, outputContains: c.outputContains ?? "" });
async function load() {
  try {
    rows.value = (await api<{ checks: Check[] }>("/api/v1/settings/remediation/verification")).checks.map(toRow);
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(load);

const add = () => rows.value.push({ image: "", command: "", expectExit: 0, outputContains: "" });
const remove = (i: number) => rows.value.splice(i, 1);

async function save() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const checks = rows.value.map((r) => ({
      image: r.image.trim(),
      // Un argument par ligne : aucun découpage, aucun shell.
      command: r.command.split("\n").map((l) => l.trim()).filter(Boolean),
      expectExit: Number(r.expectExit),
      outputContains: r.outputContains.trim() || null,
    }));
    rows.value = (await api<{ checks: Check[] }>("/api/v1/settings/remediation/verification", { method: "PUT", body: JSON.stringify({ checks }) })).checks.map(toRow);
    info.value = "Vérifications enregistrées.";
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PanelCard title="Vérification de démarrage des correctifs" icon="shield-halved" subtitle="Facultative, par image : l'image corrigée démarre-t-elle encore ?">
    <p class="text-sm text-slate-600">
      Pour une image, la console peut lancer une <strong>commande</strong> (ex. <code>nginx -t</code>, <code>node --version</code>) dans un conteneur jetable de l'image <strong>d'origine</strong> puis de l'image <strong>corrigée</strong> :
      si elle réussit avant et échoue après, le correctif est <strong>refusé</strong> (régression). Le conteneur est isolé : <strong>sans réseau</strong>, système de fichiers en lecture seule, sans capacités, sans volume ni variable d'environnement de l'application, 30 s au plus.
      Ce n'est qu'un garde-fou léger : il ne remplace pas un test de l'application.
    </p>
    <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="mt-2 text-sm text-green-700">{{ info }}</p>

    <form class="mt-4 space-y-4 text-sm" @submit.prevent="save">
      <p v-if="rows.length === 0" class="text-slate-500">Aucune vérification configurée.</p>
      <fieldset v-for="(r, i) in rows" :key="i" class="space-y-2 rounded border border-slate-200 p-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block"><span class="font-medium">Image (sans étiquette)</span><input v-model="r.image" required :disabled="!canEdit" placeholder="nginx ou ghcr.io/org/app" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs" /></label>
          <label class="block"><span class="font-medium">Code de sortie attendu</span><input v-model.number="r.expectExit" type="number" min="0" max="255" :disabled="!canEdit" class="mt-1 w-28 rounded border border-slate-300 px-3 py-2" /></label>
        </div>
        <label class="block">
          <span class="font-medium">Commande (un argument par ligne)</span>
          <textarea v-model="r.command" required rows="2" :disabled="!canEdit" placeholder="nginx&#10;-t" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"></textarea>
          <span class="text-xs text-slate-500">Passée à l'image après son ENTRYPOINT, sans shell.</span>
        </label>
        <label class="block"><span class="font-medium">La sortie doit contenir (facultatif, texte littéral)</span><input v-model="r.outputContains" :disabled="!canEdit" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs" /></label>
        <button v-if="canEdit" type="button" class="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50" @click="remove(i)">Retirer</button>
      </fieldset>
      <div v-if="canEdit" class="flex flex-wrap gap-2">
        <button type="button" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="add">Ajouter une vérification</button>
        <button class="rounded-md bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy">Enregistrer</button>
      </div>
      <p v-else class="text-xs text-slate-500">Seul un administrateur peut modifier ces réglages.</p>
    </form>
  </PanelCard>
</template>
