<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api, describeError, formatBytes, type OperationView, type RemovalPlanView } from "../api";
import { defaultSelection, hostHasWork, nameMatches, type RemovalSelection } from "../removal-selection";
import OperationLog from "./OperationLog.vue";

// Suppression d'une application (administrateurs) : liste de ce qui sera retiré, cases à décocher, puis confirmation par
// la saisie du nom. L'hôte est nettoyé par une opération suivie en direct ; la configuration de la console n'est supprimée
// qu'ensuite, si l'hôte a bien été nettoyé.
const props = defineProps<{ stackId: string; stackName: string }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();

const plan = ref<RemovalPlanView | null>(null);
const loading = ref(true);
const error = ref("");
const typed = ref("");
const removeFromConsole = ref(true);
const sel = reactive<RemovalSelection>({ networks: false, workspace: false, volumes: [], images: [] });
const phase = ref<"form" | "running" | "failed">("form");
const operationId = ref("");
const busy = ref(false);

const host = computed(() => (plan.value?.host.available ? plan.value.host : null));
const blockedReason = computed(() => {
  if (!plan.value) return "";
  if (plan.value.busy) return "Une opération est en cours sur cette application : attendez sa fin.";
  if (host.value && host.value.running > 0) return "Un conteneur de l'application est en marche : arrêtez-la d'abord.";
  return "";
});
const hostWork = computed(() => (host.value ? hostHasWork(host.value, sel) : false));
/** Ce qui sera réellement fait : l'hôte (si disponible) et/ou la configuration de la console. */
const hasAction = computed(() => hostWork.value || removeFromConsole.value);
const canConfirm = computed(() => !!plan.value && !blockedReason.value && nameMatches(typed.value, props.stackName) && hasAction.value && !busy.value);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    plan.value = await api<RemovalPlanView>(`/api/v1/stacks/${props.stackId}/removal-plan`, { method: "POST", body: JSON.stringify({}) });
    if (plan.value.host.available) Object.assign(sel, defaultSelection(plan.value.host));
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

function toggle(list: string[], value: string, on: boolean) {
  const i = list.indexOf(value);
  if (on && i === -1) list.push(value);
  if (!on && i !== -1) list.splice(i, 1);
}

/** Supprime la configuration de la console (si demandé), puis revient à la liste des applications. */
async function finalize(skipHost: boolean) {
  if (!removeFromConsole.value) {
    emit("close");
    return;
  }
  await api(`/api/v1/stacks/${props.stackId}`, { method: "DELETE", body: JSON.stringify({ confirmName: typed.value, skipHost }) });
  await router.push("/stacks");
}

async function confirmDelete() {
  error.value = "";
  busy.value = true;
  try {
    if (host.value && hostWork.value) {
      const r = await api<{ operationId: string }>(`/api/v1/stacks/${props.stackId}/destroy`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ confirmName: typed.value, networks: sel.networks, volumes: sel.volumes, images: sel.images, workspace: sel.workspace }),
      });
      operationId.value = r.operationId;
      phase.value = "running";
    } else {
      // Rien à retirer de l'hôte (jamais déployée, ou hôte hors ligne et confirmation explicite) : configuration seulement.
      await finalize(!host.value);
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function onFinished(op: OperationView) {
  if (op.status !== "succeeded") {
    phase.value = "failed";
    return;
  }
  try {
    await finalize(false);
  } catch (err) {
    error.value = describeError(err);
    phase.value = "failed";
  }
}

async function retry() {
  phase.value = "form";
  operationId.value = "";
  await load();
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && phase.value !== "running") emit("close");
};
onMounted(() => {
  document.addEventListener("keydown", onKey);
  void load();
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

const input = "rounded border border-slate-300 px-3 py-2";
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="phase !== 'running' && emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`Supprimer ${stackName}`" class="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold text-red-700">Supprimer « {{ stackName }} »</h2>
          <p class="text-xs text-slate-500">Action irréversible. Décochez ce que vous voulez conserver.</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Fermer" :disabled="phase === 'running'" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div class="space-y-4 p-6 text-sm">
        <p v-if="loading" class="rounded bg-slate-100 p-3 text-slate-700">Relevé de ce qui sera supprimé…</p>
        <p v-if="error" role="alert" class="rounded border border-red-200 bg-red-50 p-3 text-red-800">{{ error }}</p>

        <template v-if="plan && phase === 'form'">
          <p v-if="blockedReason" role="alert" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">{{ blockedReason }}</p>
          <p v-if="!plan.host.available" role="status" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">{{ plan.host.reason }}</p>

          <section v-if="host" class="space-y-3">
            <h3 class="font-medium">Sur l'hôte</h3>

            <div v-if="host.containers.length">
              <label class="flex items-center gap-2 opacity-70"><input type="checkbox" checked disabled /> Conteneurs de l'application ({{ host.containers.length }}) <span class="text-xs text-slate-500">toujours supprimés</span></label>
              <ul class="ml-6 list-disc text-xs text-slate-600"><li v-for="c in host.containers" :key="c.id">{{ c.name }} <span class="text-slate-400">({{ c.state }})</span></li></ul>
            </div>
            <p v-else class="text-xs text-slate-500">Aucun conteneur de cette application sur l'hôte.</p>

            <div v-if="host.networks.length">
              <label class="flex items-center gap-2"><input v-model="sel.networks" type="checkbox" /> Réseaux créés par l'application ({{ host.networks.length }})</label>
              <ul class="ml-6 list-disc text-xs text-slate-600"><li v-for="n in host.networks" :key="n.id">{{ n.name }}</li></ul>
              <p class="ml-6 text-xs text-slate-500">Les réseaux externes (ex. shared_network) ne sont jamais supprimés.</p>
            </div>

            <div v-if="host.volumes.length" class="rounded border border-red-200 bg-red-50/50 p-3">
              <p class="font-medium text-red-800">Volumes (données de l'application)</p>
              <p class="text-xs text-red-700">Décochés par défaut : un volume supprimé ne peut pas être récupéré.</p>
              <label v-for="v in host.volumes" :key="v.name" class="mt-1 flex items-center gap-2">
                <input type="checkbox" :checked="sel.volumes.includes(v.name)" @change="toggle(sel.volumes, v.name, ($event.target as HTMLInputElement).checked)" />
                <span class="font-mono text-xs">{{ v.name }}</span>
                <span v-if="v.sizeBytes !== null" class="text-xs text-slate-500">{{ formatBytes(v.sizeBytes) }}</span>
              </label>
            </div>

            <div v-if="host.images.length">
              <p class="font-medium">Images</p>
              <label v-for="i in host.images" :key="i.id" class="flex items-center gap-2" :class="{ 'opacity-60': i.usedByOthers > 0 }">
                <input type="checkbox" :disabled="i.usedByOthers > 0" :checked="sel.images.includes(i.ref)" @change="toggle(sel.images, i.ref, ($event.target as HTMLInputElement).checked)" />
                <span class="font-mono text-xs">{{ i.ref }}</span>
                <span v-if="i.usedByOthers > 0" class="text-xs text-amber-700">utilisée par {{ i.usedByOthers }} autre(s) conteneur(s) : conservée</span>
              </label>
            </div>

            <label v-if="host.workspace" class="flex items-start gap-2">
              <input v-model="sel.workspace" type="checkbox" class="mt-1" />
              <span>Dossier de travail de l'application sur l'hôte<span class="block text-xs text-slate-500">Compose, fichier .env (secrets) et Dockerfiles. Les dossiers montés ci-dessous ne sont pas concernés.</span></span>
            </label>

            <div v-if="host.binds.length" class="rounded bg-slate-50 p-3">
              <p class="font-medium">Dossiers de l'hôte montés dans les conteneurs : conservés</p>
              <ul class="mt-1 list-disc pl-5 font-mono text-xs text-slate-600"><li v-for="b in host.binds" :key="b">{{ b }}</li></ul>
              <p class="mt-1 text-xs text-slate-500">La console ne supprime jamais ces dossiers : supprimez-les vous-même sur l'hôte si besoin.</p>
            </div>
          </section>

          <section class="space-y-1">
            <h3 class="font-medium">Dans la console</h3>
            <label class="flex items-start gap-2">
              <input v-model="removeFromConsole" type="checkbox" class="mt-1" />
              <span>Supprimer l'application de la console<span class="block text-xs text-slate-500">{{ plan.console.revisions }} révision(s) avec leurs variables et fichiers, {{ plan.console.operations }} opération(s), {{ plan.console.imageChecks }} vérification(s) et règle(s) d'images. Elle disparaîtra aussi de la sauvegarde Git à la prochaine sauvegarde (l'historique Git la conserve).</span></span>
            </label>
            <p v-if="!removeFromConsole && host" class="text-xs text-slate-500">Décoché : seuls les éléments de l'hôte sont retirés, l'application reste enregistrée (non déployée).</p>
          </section>

          <label class="block">
            <span class="mb-1 block font-medium">Pour confirmer, tapez le nom de l'application : <code class="rounded bg-slate-100 px-1">{{ stackName }}</code></span>
            <input v-model="typed" autocomplete="off" spellcheck="false" :class="[input, 'w-full font-mono']" :aria-label="`Saisir ${stackName} pour confirmer`" />
          </label>
        </template>

        <template v-if="phase !== 'form'">
          <p v-if="phase === 'running'" class="text-slate-600">Suppression en cours sur l'hôte… Ne fermez pas cette fenêtre.</p>
          <OperationLog v-if="operationId" :operation-id="operationId" :stack-id="stackId" @finished="onFinished" />
          <p v-if="phase === 'failed'" role="alert" class="text-red-700">La suppression n'est pas terminée : l'application est conservée dans la console. Corrigez le problème (journal ci-dessus) puis réessayez.</p>
        </template>
      </div>

      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <template v-if="phase === 'failed'">
          <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">Fermer</button>
          <button class="rounded bg-red-600 px-3 py-2 text-white hover:bg-red-700" @click="retry">Réessayer</button>
        </template>
        <template v-else-if="phase === 'form'">
          <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">Annuler</button>
          <button :disabled="!canConfirm" class="rounded bg-red-600 px-3 py-2 text-white hover:bg-red-700 disabled:opacity-40" @click="confirmDelete">Supprimer définitivement</button>
        </template>
      </footer>
    </div>
  </div>
</template>
