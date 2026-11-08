<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { findActiveOperation } from "../../active-operation";
import { healthApplies } from "../../container-health";
import { api, describeError, fmtDate, type Container, type OperationView, type StackDetail } from "../../api";
import CustomImageDialog from "../../components/CustomImageDialog.vue";
import DeployDialog from "../../components/DeployDialog.vue";
import HealthcheckDialog from "../../components/HealthcheckDialog.vue";
import OperationLog from "../../components/OperationLog.vue";
import RevisionDiff from "../../components/RevisionDiff.vue";
import { useSession } from "../../stores/session";

const props = defineProps<{ stack: StackDetail }>();
const session = useSession();
const emit = defineEmits<{ changed: [] }>();

const operationId = ref("");
/** Une opération de cette stack est en attente ou en cours : les actions sont bloquées (le serveur les refuserait). */
const operationActive = ref(false);
const error = ref("");
const busy = ref(false);
const hcTarget = ref<Container | null>(null);
const imageTarget = ref<Container | null>(null);
const hcInfo = ref("");
const probeOpen = ref<string | null>(null);
const showDiff = ref(false);
/** Révision confirmée dans la boîte de déploiement (figée à l'ouverture) ; null = boîte fermée. */
const deployTarget = ref<number | null>(null);

/** Texte de l'infobulle : raison du dernier test, ou à défaut une indication générale. */
function probeTitle(c: Container): string {
  const p = c.healthProbe;
  if (!p) return "Détail du test indisponible (inventaire pas encore rafraîchi).";
  const out = p.output.replace(/\s+/g, " ").trim().slice(0, 300);
  return `Code de sortie ${p.exitCode}${p.at ? " · " + fmtDate(p.at) : ""}\n${out || "(aucune sortie)"}\nCliquer pour le détail`;
}

// --- État de la stack : en service, prête à déployer ----------------------------------------------------
const deployed = computed(() => props.stack.deployedRevision);
const state = computed<"first" | "pending" | "current">(() => (deployed.value === null ? "first" : deployed.value === props.stack.currentRevision ? "current" : "pending"));
const deployLabel = computed(() => {
  const r = props.stack.currentRevision;
  if (state.value === "first") return `Premier déploiement (révision ${r})`;
  if (state.value === "pending") return `Déployer la révision ${r}`;
  return `Redéployer la révision ${r} (en service)`;
});
const offline = computed(() => props.stack.hostPresence === "offline");
/** Pourquoi une action est indisponible, pour l'expliquer plutôt que de griser sans rien dire. */
const blocked = computed(() => {
  if (!session.canOperate) return "Votre rôle (lecteur) ne permet pas de lancer des actions.";
  if (offline.value) return "L'agent de l'hôte est hors ligne : aucune action ne peut être lancée.";
  if (operationActive.value) return "Une opération est en cours sur cette application : les actions sont disponibles à sa fin.";
  return "";
});
const neverDeployed = computed(() => deployed.value === null);

// « Préparer le premier déploiement » (après création) ouvre directement la confirmation, sans lancer quoi que ce soit.
const route = useRoute();
const router = useRouter();
// Après un rafraîchissement de la page, reprend le suivi d'une opération encore active (lancée ici, ailleurs ou par un autre utilisateur).
async function resumeActiveOperation() {
  try {
    const { operations } = await api<{ operations: Pick<OperationView, "id" | "status">[] }>(`/api/v1/operations?stackId=${props.stack.id}&limit=5`);
    const active = findActiveOperation(operations);
    if (active && !operationId.value) {
      operationId.value = active.id;
      operationActive.value = true;
    }
  } catch {
    /* lecture impossible : la vue fonctionne comme avant, le serveur refuse tout lancement concurrent */
  }
}

function onOperationFinished() {
  operationActive.value = false;
  emit("changed");
}

onMounted(() => {
  void resumeActiveOperation();
  if (route.query.deploy !== "1") return;
  const { deploy: _drop, ...rest } = route.query;
  void router.replace({ query: rest });
  if (!blocked.value) deployTarget.value = props.stack.currentRevision;
});

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

function onDeployStarted(id: string) {
  deployTarget.value = null;
  hcInfo.value = "";
  error.value = "";
  operationId.value = id;
  operationActive.value = true;
}

/** Démarrer et arrêter agissent sur la dernière configuration déployée : pas de choix de révision. */
async function run(action: "stop" | "start") {
  error.value = "";
  hcInfo.value = "";
  if (action === "stop" && !confirm(`Arrêter la stack « ${props.stack.name} » ? Les conteneurs sont stoppés, les volumes et la configuration sont conservés.`)) return;
  busy.value = true;
  try {
    const r = await api<{ operationId: string }>(`/api/v1/stacks/${props.stack.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    operationId.value = r.operationId;
    operationActive.value = true;
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

      <dl class="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt class="text-slate-500">Application</dt><dd class="font-medium">{{ stack.name }}</dd>
        <dt class="text-slate-500">Hôte</dt>
        <dd>
          <RouterLink to="/hosts" class="underline">{{ stack.hostName }}</RouterLink>
          <span class="ml-1" :class="offline ? 'text-red-700' : 'text-green-700'">({{ offline ? "hors ligne" : "en ligne" }})</span>
        </dd>
        <dt class="text-slate-500">En service</dt>
        <dd><template v-if="deployed !== null">révision <strong>{{ deployed }}</strong></template><span v-else class="text-slate-600">aucune : jamais déployée</span></dd>
        <dt class="text-slate-500">Prête à déployer</dt>
        <dd>
          <template v-if="state === 'pending'">
            révision <strong>{{ stack.currentRevision }}</strong>
            <button class="ml-2 underline" :aria-expanded="showDiff" @click="showDiff = !showDiff">{{ showDiff ? "Masquer" : "Voir" }} les différences</button>
          </template>
          <template v-else-if="state === 'first'">révision <strong>{{ stack.currentRevision }}</strong></template>
          <span v-else class="text-slate-600">rien : la révision {{ stack.currentRevision }} est déjà en service</span>
        </dd>
      </dl>
      <div v-if="showDiff && state === 'pending'" class="mt-3 max-h-96 overflow-auto rounded border border-slate-200 p-3">
        <RevisionDiff :stack-id="stack.id" :from="deployed" :to="stack.currentRevision" />
      </div>

      <p v-if="blocked" role="status" class="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {{ blocked }}
        <template v-if="offline">L'état affiché est la dernière observation. <RouterLink to="/hosts" class="underline">Voir l'hôte</RouterLink></template>
      </p>

      <div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button :disabled="busy || !!blocked" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="deployTarget = stack.currentRevision">{{ deployLabel }}</button>
        <span class="mx-1 text-slate-300">|</span>
        <button
          :disabled="busy || !!blocked || neverDeployed"
          :title="neverDeployed ? 'Rien n\'a été déployé : faites d\'abord un premier déploiement.' : `Relance la dernière configuration déployée (révision ${deployed})`"
          class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50"
          @click="run('start')"
        >
Démarrer
</button>
        <button
          :disabled="busy || !!blocked || neverDeployed"
          :title="neverDeployed ? 'Rien n\'a été déployé : il n\'y a rien à arrêter.' : 'Arrête les conteneurs (volumes et configuration conservés)'"
          class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50"
          @click="run('stop')"
        >
Arrêter
</button>
      </div>
      <p class="mt-2 text-xs text-slate-500">
        « Démarrer » relance la dernière configuration déployée ; un brouillon enregistré n'est appliqué que par le déploiement. Le déploiement demande confirmation de la révision exacte et propose des options avancées (téléchargement des images, recréation forcée).
      </p>
      <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
    </section>

    <DeployDialog v-if="deployTarget !== null" :stack="stack" :target="deployTarget" @close="deployTarget = null" @started="onDeployStarted" />

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

    <OperationLog v-if="operationId" :operation-id="operationId" :stack-id="stack.id" @finished="onOperationFinished" />

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
              <span v-if="!healthApplies(c.state)" class="text-xs text-slate-400" title="Conteneur arrêté : le dernier état de santé n'est plus significatif">— arrêté</span>
              <span v-else-if="c.health === 'healthy'" class="rounded bg-green-100 px-1.5 text-xs text-green-800">sain</span>
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
