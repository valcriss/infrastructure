<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ago, api, describeError, fmtDate, formatBytes, type StorageView } from "../api";
import PanelCard from "./PanelCard.vue";

// Stockage d'un projet Compose, géré ou observé : volumes nommés et dossiers « bind » avec leur taille sur le disque.
// Les tailles viennent de l'agent (relevé périodique, ou à la demande avec « Mesurer »).
const props = defineProps<{ hostId: string; project: string; offline?: boolean }>();

const view = ref<StorageView | null>(null);
const error = ref("");
const requesting = ref(false);
let timer: number | undefined;

const base = computed(() => `/api/v1/hosts/${props.hostId}/projects/${encodeURIComponent(props.project)}/storage`);
const measuring = computed(() => requesting.value || view.value?.measuring === true);

async function load() {
  try {
    view.value = await api<StorageView>(base.value);
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
  // Pendant une mesure, on relit rapidement jusqu'à son terme ; sinon la page se contente d'un relevé occasionnel.
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void load(), view.value?.measuring ? 4_000 : 30_000);
}

async function measure() {
  requesting.value = true;
  error.value = "";
  try {
    view.value = await api<StorageView>(`${base.value}/measure`, { method: "POST" });
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(), 4_000);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    requesting.value = false;
  }
}

onMounted(() => void load());
onBeforeUnmount(() => window.clearTimeout(timer));

const KIND = { volume: "volume", bind: "dossier", tmpfs: "mémoire" } as const;
</script>

<template>
  <PanelCard title="Stockage" icon="hard-drive" subtitle="Volumes et dossiers montés dans les conteneurs, avec leur taille sur le disque">
    <template #actions>
      <button
        class="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
        :disabled="measuring || offline"
        :title="offline ? 'L\'agent de l\'hôte est hors ligne' : 'Mesurer maintenant la taille des volumes et des dossiers'"
        @click="measure"
      >
        <FaIcon :icon="['fas', 'arrows-rotate']" :spin="measuring" /> {{ measuring ? "Mesure en cours…" : "Mesurer" }}
      </button>
    </template>
    <p v-if="error" role="alert" class="mb-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="view && view.items.length === 0" class="text-sm text-slate-500">Aucun volume ni dossier monté dans les conteneurs de ce projet.</p>
    <div v-else-if="view" class="overflow-x-auto">
      <table class="w-full min-w-[640px] text-left text-sm">
        <thead class="border-b border-slate-200 text-xs text-slate-500">
          <tr>
            <th scope="col" class="py-2 pr-3 font-medium">Type</th>
            <th scope="col" class="py-2 pr-3 font-medium">Source</th>
            <th scope="col" class="py-2 pr-3 font-medium">Utilisé par</th>
            <th scope="col" class="py-2 pr-3 font-medium">Accès</th>
            <th scope="col" class="py-2 text-right font-medium">Taille sur le disque</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(i, n) in view.items" :key="n" class="border-b border-slate-100 align-top last:border-0">
            <td class="py-2 pr-3 text-xs text-slate-500">{{ KIND[i.kind] }}</td>
            <td class="break-all py-2 pr-3 font-mono text-xs">{{ i.source ?? "—" }}</td>
            <td class="py-2 pr-3 text-xs">
              <p v-for="(u, k) in i.usedBy" :key="k">
                <span class="font-medium">{{ u.service }}</span> <span class="text-slate-400">→</span> <span class="break-all font-mono">{{ u.destination }}</span>
              </p>
            </td>
            <td class="py-2 pr-3 text-xs text-slate-500">{{ i.usedBy.every((u) => !u.rw) ? "lecture seule" : "lecture-écriture" }}</td>
            <td class="py-2 text-right tabular-nums">
              <template v-if="i.kind === 'tmpfs'"><span class="text-xs text-slate-400">—</span></template>
              <template v-else-if="i.sizeBytes !== null">
                <span class="font-medium" :title="i.measuredAt ? `Mesuré ${fmtDate(i.measuredAt)}` : ''">{{ formatBytes(i.sizeBytes) }}</span>
                <p v-if="i.note" class="text-xs text-amber-700">dernière mesure : {{ i.note }}</p>
              </template>
              <span v-else class="text-xs text-slate-500">{{ i.note ?? (measuring ? "mesure en cours…" : "pas encore mesuré") }}</span>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="view.totalBytes !== null" class="border-t border-slate-200">
          <tr>
            <th scope="row" colspan="4" class="py-2 pr-3 text-left font-medium">Total</th>
            <td class="py-2 text-right font-semibold tabular-nums">{{ formatBytes(view.totalBytes) }}</td>
          </tr>
        </tfoot>
      </table>
      <p class="mt-2 text-xs text-slate-500">
        <template v-if="view.measuredAt">Dernière mesure {{ ago(view.measuredAt) }}</template><template v-else>Aucune mesure pour l'instant</template>
        · relevé automatique toutes les 6 h environ.
        <span v-if="view.unmeasured > 0 && view.totalBytes !== null">{{ view.unmeasured }} montage(s) non mesuré(s) : le total est partiel.</span>
        Un dossier contenu dans un autre est compté deux fois.
      </p>
    </div>
    <p v-else-if="!error" class="text-sm text-slate-500">Chargement…</p>
  </PanelCard>
</template>
