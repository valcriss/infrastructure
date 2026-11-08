<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, describeError, fmtDate, type AcceptedRisk } from "../api";
import { useSession } from "../stores/session";
import PanelCard from "./PanelCard.vue";

// Liste des risques acceptés : vulnérabilités qu'on ne compte plus jusqu'à une date limite.
const session = useSession();
const items = ref<AcceptedRisk[]>([]);
const error = ref("");

async function load() {
  try {
    items.value = (await api<{ acceptances: AcceptedRisk[] }>("/api/v1/vulnerability-acceptances")).acceptances;
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(() => void load());

async function revoke(r: AcceptedRisk) {
  if (!window.confirm(`Ne plus accepter ${r.cve} ? Elle sera de nouveau comptée.`)) return;
  try {
    await api(`/api/v1/vulnerability-acceptances/${r.id}`, { method: "DELETE" });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

const scope = (r: AcceptedRisk): string => (r.repository ? r.repository.replace(/^docker\.io\//, "").replace(/^library\//, "") : "toutes les images");
</script>

<template>
  <PanelCard title="Risques acceptés" icon="circle-check" subtitle="Vulnérabilités qu'on ne compte plus (alertes, tableaux de bord) jusqu'à leur date limite. Le scan reste complet. Ajoutez-en depuis le détail d'une image.">
    <p v-if="error" role="alert" class="mb-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="items.length === 0" class="text-sm text-slate-500">Aucun risque accepté.</p>
    <ul v-else class="divide-y divide-slate-200 text-sm">
      <li v-for="r in items" :key="r.id" class="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
        <div class="min-w-0 flex-1">
          <p class="font-medium">
            {{ r.cve }} <span class="font-normal text-slate-500">· {{ scope(r) }}</span>
            <span v-if="r.expired" class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">expiré : de nouveau compté</span>
          </p>
          <p class="text-slate-600">{{ r.justification }}</p>
          <p class="text-xs text-slate-500">Par {{ r.createdBy }} le {{ fmtDate(r.createdAt) }} · valable jusqu'au {{ fmtDate(r.expiresAt).slice(0, 10) }}</p>
        </div>
        <button v-if="session.isAdmin" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="revoke(r)">Révoquer</button>
      </li>
    </ul>
  </PanelCard>
</template>
