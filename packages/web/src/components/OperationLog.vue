<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, fmtDate, type OperationView } from "../api";

const props = defineProps<{ operationId: string }>();
const emit = defineEmits<{ finished: [op: OperationView] }>();

const op = ref<OperationView | null>(null);
const error = ref("");
let timer: number | undefined;

const finalStatus = (s: string) => s === "succeeded" || s === "failed" || s === "unknown";
const labels: Record<string, string> = {
  pending: "en attente",
  running: "en cours",
  succeeded: "réussie",
  failed: "échouée",
  unknown: "résultat inconnu",
};
const colors: Record<string, string> = {
  pending: "bg-slate-200 text-slate-800",
  running: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  unknown: "bg-amber-100 text-amber-800",
};
const typeLabel = computed(() => ({ deploy: "Déploiement", stop: "Arrêt", start: "Démarrage" })[op.value?.type ?? "deploy"]);

async function poll() {
  window.clearTimeout(timer);
  try {
    op.value = await api<OperationView>(`/api/v1/operations/${props.operationId}`);
    error.value = "";
    if (finalStatus(op.value.status)) {
      emit("finished", op.value);
      return;
    }
  } catch {
    error.value = "Impossible de lire l'opération.";
  }
  timer = window.setTimeout(poll, 1000);
}

watch(() => props.operationId, () => void poll(), { immediate: true });
onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-live="polite">
    <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>
    <template v-if="op">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium">{{ typeLabel }}</span>
        <span v-if="op.revision" class="text-slate-500">révision {{ op.revision }}</span>
        <span class="rounded px-2 py-0.5 text-xs" :class="colors[op.status]">{{ labels[op.status] }}</span>
        <span class="text-xs text-slate-500">{{ fmtDate(op.createdAt) }} · {{ op.requestedBy }}</span>
      </div>
      <p v-if="op.error" class="mt-2 text-red-700">{{ op.error }}</p>
      <p v-if="op.status === 'unknown'" class="mt-2 text-amber-700">
        Le résultat est inconnu : rien n'a été rejoué automatiquement. Vérifiez l'état réel avant de relancer.
      </p>
      <pre class="mt-3 max-h-72 overflow-auto rounded bg-slate-900 p-3 font-mono text-xs text-slate-100">{{ op.log || "(aucune sortie)" }}</pre>
      <div v-if="op.result?.images?.length" class="mt-3">
        <h4 class="font-medium">Images déployées</h4>
        <ul class="mt-1 space-y-1 font-mono text-xs">
          <li v-for="i in op.result.images" :key="i.service">
            {{ i.service }} → {{ i.image }}
            <span class="text-slate-500">{{ i.repoDigests[0] ?? "(sans digest)" }}</span>
          </li>
        </ul>
      </div>
      <div v-if="op.result?.services?.length" class="mt-3">
        <h4 class="font-medium">État observé après exécution</h4>
        <ul class="mt-1 text-xs">
          <li v-for="s in op.result.services" :key="s.service">{{ s.service }} : {{ s.state }}{{ s.health ? ` (${s.health})` : "" }}</li>
        </ul>
      </div>
    </template>
    <p v-else class="text-slate-500">Chargement…</p>
  </section>
</template>
