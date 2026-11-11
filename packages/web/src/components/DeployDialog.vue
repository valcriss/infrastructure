<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, describeError, type StackDetail } from "../api";
import RevisionDiff from "./RevisionDiff.vue";

// Confirmation d'un déploiement : on voit exactement ce qui va être appliqué (application, hôte, révision en service,
// révision cible, différences) et la révision confirmée est celle qui est envoyée, même si une autre est enregistrée entre-temps.
// `update` : mise à jour d'une image dont le contenu a changé derrière le même tag (téléchargement coché d'office).
const props = defineProps<{ stack: StackDetail; target: number; update?: { service: string } }>();
const emit = defineEmits<{ close: []; started: [operationId: string] }>();

const pull = ref(!!props.update);
const force = ref(false);
const showDiff = ref(false);
const busy = ref(false);
const error = ref("");

const deployed = computed(() => props.stack.deployedRevision);
const kind = computed<"first" | "apply" | "redeploy" | "rollback">(() => {
  if (deployed.value === null) return "first";
  if (props.target === deployed.value) return "redeploy";
  return props.target > deployed.value ? "apply" : "rollback";
});
const title = computed(() => (props.update ? "Mettre à jour" : ({ first: "Premier déploiement", apply: "Déployer", redeploy: "Redéployer", rollback: "Revenir à une révision antérieure" })[kind.value]));
const confirmLabel = computed(() => (props.update ? "Mettre à jour" : ({ first: "Premier déploiement", apply: "Déployer", redeploy: "Redéployer", rollback: "Revenir à" })[kind.value] + ` la révision ${props.target}`));
// Une révision plus récente a été enregistrée depuis l'ouverture de la boîte : on le dit, la révision confirmée reste inchangée.
const newer = computed(() => (props.stack.currentRevision > props.target ? props.stack.currentRevision : null));

async function confirm() {
  error.value = "";
  busy.value = true;
  try {
    // La révision confirmée est transmise explicitement : le serveur ne choisit jamais « la courante » à notre place.
    const r = await api<{ operationId: string }>(`/api/v1/stacks/${props.stack.id}/deploy`, {
      method: "POST",
      body: JSON.stringify({ revision: props.target, pullImages: pull.value, forceRecreate: force.value }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    emit("started", r.operationId);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`${title} ${stack.name}`" class="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <h2 class="text-lg font-semibold">{{ title }} « {{ stack.name }} »</h2>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div class="space-y-4 p-6 text-sm">
        <dl class="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2">
          <dt class="text-slate-500">Application</dt><dd class="font-medium">{{ stack.name }}</dd>
          <dt class="text-slate-500">Hôte</dt>
          <dd>
            <RouterLink to="/hosts" class="underline">{{ stack.hostName }}</RouterLink>
            <span class="ml-1" :class="stack.hostPresence === 'online' ? 'text-green-700' : 'text-red-700'">({{ stack.hostPresence === "online" ? "en ligne" : "hors ligne" }})</span>
          </dd>
          <dt class="text-slate-500">En service</dt>
          <dd><template v-if="deployed !== null">révision <strong>{{ deployed }}</strong></template><template v-else>aucune : cette stack n'a jamais été déployée</template></dd>
          <dt class="text-slate-500">Révision cible</dt><dd>révision <strong>{{ target }}</strong> <span v-if="kind === 'redeploy'" class="text-slate-500">(déjà en service)</span></dd>
        </dl>

        <p v-if="newer !== null" role="alert" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          La révision {{ newer }} a été enregistrée depuis l'ouverture de cette boîte. <strong>C'est bien la révision {{ target }} qui sera déployée</strong> ; fermez la boîte pour viser la plus récente.
        </p>
        <p v-if="kind === 'rollback'" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Vous revenez à une révision plus ancienne que celle en service : sa configuration est réappliquée, les données ne sont pas restaurées.
        </p>
        <p v-if="update" class="rounded border border-blue-300 bg-blue-50 p-3 text-blue-900">
          Le tag de « {{ update.service }} » pointe vers un nouveau contenu dans le registre. Les images de l'application sont téléchargées, puis les conteneurs dont l'image a changé sont recréés : brève interruption de ces services. La configuration (révision {{ target }}) ne change pas.
        </p>
        <p v-else-if="kind === 'redeploy'" class="text-slate-600">
          La configuration ne change pas : Docker Compose ne recrée que les conteneurs dont la configuration ou l'image diffère (voir les options avancées).
        </p>

        <div v-if="kind !== 'redeploy'">
          <button class="underline" :aria-expanded="showDiff" @click="showDiff = !showDiff">{{ showDiff ? "Masquer" : "Voir" }} les différences{{ deployed !== null ? ` avec la révision en service (${deployed})` : "" }}</button>
          <div v-if="showDiff" class="mt-3 max-h-96 overflow-auto"><RevisionDiff :stack-id="stack.id" :from="deployed" :to="target" /></div>
        </div>

        <details class="rounded border border-slate-200 p-3">
          <summary class="cursor-pointer font-medium">Options avancées</summary>
          <div class="mt-3 space-y-3">
            <label class="flex items-start gap-2">
              <input v-model="pull" type="checkbox" class="mt-1" />
              <span>
                <span class="font-medium">Télécharger les images</span>
                <span class="block text-xs text-slate-500">Récupère les dernières versions des images avant de démarrer (<code>docker compose pull</code>). Utile pour une étiquette qui évolue (<code>latest</code>) ; plus long, et la version peut changer à votre insu.</span>
              </span>
            </label>
            <label class="flex items-start gap-2">
              <input v-model="force" type="checkbox" class="mt-1" />
              <span>
                <span class="font-medium">Forcer la recréation</span>
                <span class="block text-xs text-slate-500">Recrée tous les conteneurs même si rien n'a changé : brève interruption du service. À réserver aux cas où un conteneur reste dans un état incohérent.</span>
              </span>
            </label>
          </div>
        </details>

        <p v-if="stack.hostPresence === 'offline'" role="alert" class="text-red-700">L'agent de l'hôte est hors ligne : le déploiement ne peut pas être lancé. <RouterLink to="/hosts" class="underline">Voir l'hôte</RouterLink></p>
        <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>
      </div>

      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">Annuler</button>
        <button :disabled="busy || stack.hostPresence === 'offline'" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="confirm">{{ confirmLabel }}</button>
      </footer>
    </div>
  </div>
</template>
