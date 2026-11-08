<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, fmtDate, type OperationView } from "../api";

// `stackId` : permet de proposer le bon diagnostic (configuration, logs, hôte) quand l'opération échoue.
const props = defineProps<{ operationId: string; stackId?: string }>();
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

// Étapes d'un déploiement, d'après les lignes écrites par l'agent : la dernière rencontrée est celle qui a échoué.
const STEPS: { match: RegExp; label: string; where: "config" | "apply" }[] = [
  { match: /Validation de la révision/, label: "Validation de la configuration", where: "config" },
  { match: /Téléchargement des images/, label: "Téléchargement des images", where: "config" },
  { match: /Construction des images personnalisées/, label: "Construction d'une image personnalisée", where: "config" },
  { match: /Prévisualisation des changements/, label: "Prévisualisation des changements", where: "apply" },
  { match: /Application de la configuration/, label: "Application de la configuration (démarrage des conteneurs)", where: "apply" },
  { match: /docker compose (start|stop)/, label: "Exécution de la commande Docker Compose", where: "apply" },
];
const failedStep = computed(() => {
  if (!op.value || op.value.status !== "failed") return null;
  let best: { label: string; where: "config" | "apply"; at: number } | null = null;
  for (const st of STEPS) {
    const m = [...(op.value.log ?? "").matchAll(new RegExp(st.match.source, "g"))].pop();
    if (m?.index !== undefined && (!best || m.index > best.at)) best = { label: st.label, where: st.where, at: m.index };
  }
  return best;
});
/** Diagnostics proposés selon l'étape et le message d'erreur : on ouvre directement la page utile. */
const diagnostics = computed(() => {
  const o = op.value;
  if (!props.stackId || !o || (o.status !== "failed" && o.status !== "unknown")) return [];
  const base = `/stacks/${props.stackId}`;
  const out: { label: string; to: string }[] = [];
  if (failedStep.value?.where === "config") out.push({ label: "Corriger la configuration", to: `${base}?tab=config&section=compose` });
  if (failedStep.value?.where === "apply" || o.status === "unknown") {
    out.push({ label: "Voir les logs des conteneurs", to: `${base}?tab=logs` });
    out.push({ label: "Voir l'état des conteneurs", to: base });
  }
  if (/hors ligne|connexion|agent/i.test(o.error ?? "") || o.status === "unknown") out.push({ label: "Voir l'hôte", to: "/hosts" });
  return out;
});

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
      <p v-if="failedStep" class="mt-1 text-sm text-red-700">Échec à l'étape : <strong>{{ failedStep.label }}</strong>.</p>
      <p v-else-if="op.status === 'failed' && stackId" class="mt-1 text-xs text-slate-500">Aucune étape identifiée : consultez le journal ci-dessous.</p>
      <div v-if="diagnostics.length" class="mt-2 flex flex-wrap gap-2">
        <RouterLink v-for="d in diagnostics" :key="d.label" :to="d.to" class="rounded border border-slate-300 px-3 py-1 text-xs font-medium hover:bg-slate-100">{{ d.label }}</RouterLink>
      </div>
      <p v-if="op.status === 'unknown'" class="mt-2 text-amber-700">
        Le résultat est inconnu : rien n'a été rejoué automatiquement. Vérifiez l'état réel avant de relancer.
      </p>
      <pre class="mt-3 max-h-72 overflow-auto rounded bg-[#0b1220] p-3 font-mono text-xs text-[#e2e8f0]">{{ op.log || "(aucune sortie)" }}</pre>
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
