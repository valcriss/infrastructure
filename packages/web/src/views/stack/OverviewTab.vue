<script setup lang="ts">
import { ref } from "vue";
import { api, describeError, fmtDate, type Container, type StackDetail } from "../../api";
import CustomImageDialog from "../../components/CustomImageDialog.vue";
import HealthcheckDialog from "../../components/HealthcheckDialog.vue";
import OperationLog from "../../components/OperationLog.vue";
import { useSession } from "../../stores/session";

const props = defineProps<{ stack: StackDetail }>();
const session = useSession();
const emit = defineEmits<{ changed: [] }>();

const pull = ref(false);
const force = ref(false);
const operationId = ref("");
const error = ref("");
const busy = ref(false);
const hcTarget = ref<Container | null>(null);
const imageTarget = ref<Container | null>(null);
const hcInfo = ref("");
const probeOpen = ref<string | null>(null);

/** Texte de l'infobulle : raison du dernier test, ou à défaut une indication générale. */
function probeTitle(c: Container): string {
  const p = c.healthProbe;
  if (!p) return "Détail du test indisponible (inventaire pas encore rafraîchi).";
  const out = p.output.replace(/s+/g, " ").trim().slice(0, 300);
  return `Code de sortie ${p.exitCode}${p.at ? " · " + fmtDate(p.at) : ""}
${out || "(aucune sortie)"}
Cliquer pour le détail`;
}

function onHcSaved(revision: number) {
  hcTarget.value = null;
  hcInfo.value = `Révision ${revision} enregistrée avec le healthcheck. Elle n'est pas déployée : utilisez « Déployer » pour l'appliquer.`;
  emit("changed");
}

function onImageSaved(revision: number) {
  imageTarget.value = null;
  hcInfo.value = `Révision ${revision} enregistrée avec l'image personnalisée. Elle n'est pas déployée : utilisez « Déployer » pour construire et appliquer l'image.`;
  emit("changed");
}

async function run(action: "deploy" | "stop" | "start") {
  error.value = "";
  hcInfo.value = "";
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
        <button :disabled="busy || !session.canOperate || stack.hostPresence === 'offline'" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="run('deploy')">
          <template v-if="stack.deployedRevision === stack.currentRevision">Redéployer la révision {{ stack.currentRevision }} (active)</template>
          <template v-else>Déployer la révision {{ stack.currentRevision }}</template>
        </button>
        <label class="flex items-center gap-1"><input v-model="pull" type="checkbox" /> Télécharger les images</label>
        <label class="flex items-center gap-1"><input v-model="force" type="checkbox" /> Forcer la recréation</label>
        <span class="mx-2 text-slate-300">|</span>
        <button :disabled="busy || !session.canOperate || stack.hostPresence === 'offline'" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" @click="run('start')">Démarrer</button>
        <button :disabled="busy || !session.canOperate || stack.hostPresence === 'offline'" class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50" @click="run('stop')">Arrêter</button>
      </div>
      <p class="mt-2 text-xs text-slate-500">
        « Démarrer » relance la dernière configuration déployée ; un brouillon enregistré n'est appliqué que par « Déployer ».
      </p>
      <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
    </section>

    <p v-if="hcInfo" role="status" class="text-sm text-green-700">{{ hcInfo }}</p>
    <HealthcheckDialog
      v-if="hcTarget && hcTarget.composeService"
      :stack-id="stack.id"
      :host-id="stack.hostId"
      :revision="stack.currentRevision"
      :service="hcTarget.composeService"
      :container="hcTarget"
      @close="hcTarget = null"
      @saved="onHcSaved"
      @custom-image="imageTarget = hcTarget; hcTarget = null"
    />
    <CustomImageDialog
      v-if="imageTarget && imageTarget.composeService"
      :stack-id="stack.id"
      :host-id="stack.hostId"
      :revision="stack.currentRevision"
      :service="imageTarget.composeService"
      :container="imageTarget"
      @close="imageTarget = null"
      @saved="onImageSaved"
    />

    <OperationLog v-if="operationId" :operation-id="operationId" @finished="emit('changed')" />

    <section class="rounded-lg border border-slate-200 bg-white">
      <h2 class="border-b border-slate-200 px-4 py-2 font-semibold">Conteneurs observés</h2>
      <p v-if="stack.containers.length === 0" class="px-4 py-3 text-sm text-slate-500">Aucun conteneur observé pour ce projet.</p>
      <table v-else class="w-full text-left text-sm">
        <thead class="text-xs text-slate-500">
          <tr><th class="px-4 py-1">Service</th><th class="px-4 py-1">Image</th><th class="px-4 py-1">État</th><th class="px-4 py-1">Healthcheck</th><th class="px-4 py-1">Redémarrages</th></tr>
        </thead>
        <tbody>
          <template v-for="c in stack.containers" :key="c.id">
          <tr class="border-t border-slate-100">
            <td class="px-4 py-2">{{ c.composeService ?? c.names[0] }}</td>
            <td class="px-4 py-2 font-mono text-xs">{{ c.image }}</td>
            <td class="px-4 py-2">{{ c.status }}</td>
            <td class="px-4 py-2">
              <span v-if="c.health === 'healthy'" class="rounded bg-green-100 px-1.5 text-xs text-green-800">sain</span>
              <button
                v-else-if="c.health === 'unhealthy' || c.health === 'starting'"
                :class="['inline-flex items-center gap-1 rounded px-1.5 text-xs', c.health === 'unhealthy' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800']"
                :title="probeTitle(c)"
                :aria-expanded="probeOpen === c.id"
                @click="probeOpen = probeOpen === c.id ? null : c.id"
              >
                {{ c.health === "unhealthy" ? "en échec" : "démarrage" }} <FaIcon :icon="['fas', 'circle-info']" />
              </button>
              <button
                v-else-if="c.health === 'none' && c.composeService"
                class="inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-1.5 text-xs text-slate-500 hover:bg-slate-100"
                title="Proposer un healthcheck pour ce service"
                @click="hcTarget = c"
              >
                non configuré <FaIcon :icon="['fas', 'circle-question']" />
              </button>
              <span v-else-if="c.health === 'none'" class="text-xs text-slate-400">non configuré</span>
              <span v-else class="text-xs text-slate-400">—</span>
            </td>
            <td class="px-4 py-2" :class="(c.restartCount ?? 0) >= 3 ? 'font-semibold text-amber-700' : ''">{{ c.restartCount ?? "—" }}</td>
          </tr>
          <tr v-if="probeOpen === c.id && c.healthProbe" class="bg-slate-50">
            <td colspan="5" class="px-4 py-3 text-xs">
              <p class="font-medium text-slate-800">Dernier test du healthcheck de « {{ c.composeService ?? c.names[0] }} »</p>
              <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt class="text-slate-500">Résultat</dt><dd>code de sortie {{ c.healthProbe.exitCode }}{{ c.healthProbe.exitCode === 0 ? " (réussi)" : " (échec)" }}</dd>
                <template v-if="c.healthProbe.at"><dt class="text-slate-500">Date</dt><dd>{{ fmtDate(c.healthProbe.at) }}</dd></template>
                <template v-if="c.healthProbe.failingStreak !== undefined"><dt class="text-slate-500">Échecs consécutifs</dt><dd>{{ c.healthProbe.failingStreak }}<template v-if="c.healthProbe.retries"> sur {{ c.healthProbe.retries }} tolérés</template></dd></template>
                <template v-if="c.healthProbe.command"><dt class="text-slate-500">Commande</dt><dd class="break-all font-mono">{{ c.healthProbe.command }}</dd></template>
              </dl>
              <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 font-mono">{{ c.healthProbe.output || "(aucune sortie : la commande n'a rien affiché)" }}</pre>
              <p v-if="/not found|no such file|executable file/i.test(c.healthProbe.output)" class="mt-2 text-amber-700">
                L'outil du test semble absent de l'image : le service sera toujours « en échec ». Modifiez la commande du healthcheck dans le Compose.
              </p>
              <p class="mt-2 text-slate-500">Pour le contexte autour de l'échec, consultez l'onglet Logs.</p>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
    </section>
  </div>
</template>
