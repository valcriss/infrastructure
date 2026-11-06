<script setup lang="ts">
import { ref } from "vue";
import { api, describeError, type StackDetail } from "../../api";
import OperationLog from "../../components/OperationLog.vue";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

const pull = ref(false);
const force = ref(false);
const operationId = ref("");
const error = ref("");
const busy = ref(false);

async function run(action: "deploy" | "stop" | "start") {
  error.value = "";
  if (action === "stop" && !confirm(`Arrêter la stack « ${props.stack.name} » ? Les conteneurs sont stoppés, les volumes et la configuration sont conservés.`)) return;
  busy.value = true;
  try {
    const body = action === "deploy" ? { pullImages: pull.value, forceRecreate: force.value } : {};
    const r = await api<{ operationId: string }>(`/api/v1/stacks/${props.stack.id}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    operationId.value = r.operationId;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Actions</h2>
      <p v-if="stack.hostPresence === 'offline'" class="mt-2 text-sm text-amber-700">
        L'agent de l'hôte est hors ligne : l'état affiché est la dernière observation, et aucune action ne peut être lancée.
      </p>
      <div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button :disabled="busy || stack.hostPresence === 'offline'" class="rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="run('deploy')">
          Déployer la révision {{ stack.currentRevision }}
        </button>
        <label class="flex items-center gap-1"><input v-model="pull" type="checkbox" /> Télécharger les images</label>
        <label class="flex items-center gap-1"><input v-model="force" type="checkbox" /> Forcer la recréation</label>
        <span class="mx-2 text-slate-300">|</span>
        <button :disabled="busy || stack.hostPresence === 'offline'" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" @click="run('start')">Démarrer</button>
        <button :disabled="busy || stack.hostPresence === 'offline'" class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50" @click="run('stop')">Arrêter</button>
      </div>
      <p class="mt-2 text-xs text-slate-500">
        « Démarrer » relance la dernière configuration déployée ; un brouillon enregistré n'est appliqué que par « Déployer ».
      </p>
      <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
    </section>

    <OperationLog v-if="operationId" :operation-id="operationId" @finished="emit('changed')" />

    <section class="rounded-lg border border-slate-200 bg-white">
      <h2 class="border-b border-slate-200 px-4 py-2 font-semibold">Conteneurs observés</h2>
      <p v-if="stack.containers.length === 0" class="px-4 py-3 text-sm text-slate-500">Aucun conteneur observé pour ce projet.</p>
      <table v-else class="w-full text-left text-sm">
        <thead class="text-xs text-slate-500">
          <tr><th class="px-4 py-1">Service</th><th class="px-4 py-1">Image</th><th class="px-4 py-1">État</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in stack.containers" :key="c.id" class="border-t border-slate-100">
            <td class="px-4 py-2">{{ c.composeService ?? c.names[0] }}</td>
            <td class="px-4 py-2 font-mono text-xs">{{ c.image }}</td>
            <td class="px-4 py-2">{{ c.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
