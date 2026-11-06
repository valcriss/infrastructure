<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, api, fmtDate, type StackSummary } from "../api";

const stacks = ref<StackSummary[]>([]);
const loading = ref(true);
const error = ref("");
let timer: number | undefined;

async function load() {
  try {
    stacks.value = (await api<{ stacks: StackSummary[] }>("/api/v1/stacks")).stacks;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  } finally {
    loading.value = false;
  }
}

function stateOf(s: StackSummary): { text: string; cls: string } {
  if (s.deployedRevision === null) return { text: "jamais déployée", cls: "bg-slate-200 text-slate-800" };
  if (s.hostPresence === "offline") return { text: "état inconnu (hôte hors ligne)", cls: "bg-amber-100 text-amber-800" };
  if (!s.observed) return { text: "non observée", cls: "bg-slate-200 text-slate-800" };
  if (s.observed.total === 0) return { text: "aucun conteneur", cls: "bg-slate-200 text-slate-800" };
  if (s.observed.running === s.observed.total) return { text: `${s.observed.running}/${s.observed.total} en marche`, cls: "bg-green-100 text-green-800" };
  if (s.observed.running === 0) return { text: "arrêtée", cls: "bg-slate-300 text-slate-800" };
  return { text: `dégradée ${s.observed.running}/${s.observed.total}`, cls: "bg-red-100 text-red-800" };
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">Stacks</h1>
      <RouterLink to="/stacks/new" class="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700">Nouvelle stack</RouterLink>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="loading" class="text-slate-500">Chargement…</p>
    <p v-else-if="stacks.length === 0" class="text-slate-500">Aucune stack. Créez-en une depuis un fichier Compose.</p>
    <div v-else class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full text-left text-sm">
        <thead class="text-xs text-slate-500">
          <tr>
            <th class="px-4 py-2">Nom</th>
            <th class="px-4 py-2">Hôte</th>
            <th class="px-4 py-2">État observé</th>
            <th class="px-4 py-2">Révisions</th>
            <th class="px-4 py-2">Mise à jour</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in stacks" :key="s.id" class="border-t border-slate-100">
            <td class="px-4 py-2">
              <RouterLink :to="`/stacks/${s.id}`" class="font-medium text-slate-900 underline">{{ s.name }}</RouterLink>
              <p v-if="s.description" class="text-xs text-slate-500">{{ s.description }}</p>
            </td>
            <td class="px-4 py-2">{{ s.hostName }}</td>
            <td class="px-4 py-2">
              <span class="rounded px-2 py-0.5 text-xs" :class="stateOf(s).cls">{{ stateOf(s).text }}</span>
              <p v-if="s.observed" class="mt-1 text-xs text-slate-500">observé {{ fmtDate(s.observed.observedAt) }}</p>
            </td>
            <td class="px-4 py-2">
              enregistrée {{ s.currentRevision }} · déployée {{ s.deployedRevision ?? "—" }}
              <span v-if="s.pendingDeploy" class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">non déployée</span>
            </td>
            <td class="px-4 py-2 text-xs text-slate-500">{{ fmtDate(s.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
