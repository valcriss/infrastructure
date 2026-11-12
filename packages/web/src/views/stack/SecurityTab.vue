<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import ToolsMenu, { type ToolItem } from "../../components/ToolsMenu.vue";
import TrackingRuleDialog from "../../components/TrackingRuleDialog.vue";
import UpdateBadge from "../../components/UpdateBadge.vue";
import { ago, api, describeError, fmtDate, shortId, type ImageView, type StackDetail, type StackImageComponent, type UpdatePolicyName } from "../../api";
import CandidateCompare from "../../components/CandidateCompare.vue";
import CustomImageDialog from "../../components/CustomImageDialog.vue";
import DeployDialog from "../../components/DeployDialog.vue";
import OperationLog from "../../components/OperationLog.vue";
import CveHistoryChart from "../../components/CveHistoryChart.vue";
import { useSession } from "../../stores/session";
import RemediationDialog from "../../components/RemediationDialog.vue";
import { isPatchedRef } from "../../remediation";

import ScanBadge from "../../components/ScanBadge.vue";
import VulnerabilityTable from "../../components/VulnerabilityTable.vue";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();
const session = useSession();
const imageTarget = ref<string | null>(null);
const imageContainer = computed(() => props.stack.containers.find((c) => c.composeService === imageTarget.value && c.state === "running") ?? null);
function onImageSaved(revision: number) {
  imageTarget.value = null;
  info.value = `Révision ${revision} enregistrée avec l'image personnalisée. Elle n'est pas déployée : utilisez « Déployer » (vue d'ensemble) pour construire et appliquer l'image.`;
  emit("changed");
}

// Correctif d'image (remédiation) : l'image du dialogue ouvert, et le registre privé qui héberge les images corrigées.
const fixing = ref<ImageView | null>(null);
const registryHost = ref<string | null>(null);
async function loadRegistryHost() {
  try {
    registryHost.value = (await api<{ settings: { host: string } | null }>("/api/v1/settings/registry")).settings?.host ?? null;
  } catch {
    registryHost.value = null;
  }
}

const components = ref<StackImageComponent[]>([]);
const checking = ref(false);
const error = ref("");
const info = ref("");
const open = reactive<Record<string, boolean>>({});
let timer: number | undefined;

const POLICY_LABELS: Record<UpdatePolicyName, string> = { same_tag: "même tag uniquement", patch: "correctifs", minor: "mineures", major: "majeures", pattern: "expression libre" };

async function load() {
  try {
    const r = await api<{ checking: boolean; components: StackImageComponent[] }>(`/api/v1/stacks/${props.stack.id}/images`);
    components.value = r.components;
    checking.value = r.checking;
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
}

const busy = computed(() => checking.value || components.value.some((c) => ["pending", "running"].includes(c.image.scan.state)));

async function act(path: string, message: string) {
  error.value = info.value = "";
  try {
    await api(`/api/v1/stacks/${props.stack.id}/${path}`, { method: "POST" });
    info.value = message;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function ignoreTag(service: string, tag: string) {
  const reason = window.prompt(`Ne plus proposer « ${tag} » pour « ${service} » ?
Motif (facultatif, ex. incompatible avec les données) :`, "");
  if (reason === null) return;
  error.value = info.value = "";
  try {
    await api(`/api/v1/stacks/${props.stack.id}/services/${encodeURIComponent(service)}/ignored-tags`, {
      method: "POST",
      body: JSON.stringify({ tag, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    });
    info.value = `La version « ${tag} » n'est plus proposée pour « ${service} ».`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

// Mise à jour d'un même tag : redéploie la révision en service en téléchargeant les images (boîte de déploiement).
const updateService = ref<string | null>(null);
const updateOperationId = ref("");
const canUpdate = (service: string): boolean => session.canOperate && props.stack.deployedRevision !== null && props.stack.hostPresence !== "offline" && !!service;
function onUpdateStarted(id: string) {
  updateService.value = null;
  updateOperationId.value = id;
  info.value = "";
}

function onUpdateFinished() {
  emit("changed");
  void load();
}

const policyLabel = (p: UpdatePolicyName): string => POLICY_LABELS[p];

// Menu « … » d'un service : règle de suivi et image personnalisée.
const ruleTarget = ref<string | null>(null);
const ruleComponent = computed(() => components.value.find((c) => c.service === ruleTarget.value) ?? null);
const isRunning = (service: string): boolean => props.stack.containers.some((x) => x.composeService === service && x.state === "running");
function menuItems(service: string): ToolItem[] {
  return [
    { id: "rule", label: "Règle de suivi…", description: "Choisir quelles versions plus récentes proposer ; gérer les versions ignorées." },
    {
      id: "image",
      label: "Créer une image personnalisée…",
      description: "Ajoute des outils ou applique les mises à jour du système (corrige les CVE du système qui ont un correctif).",
      ...(isRunning(service) ? {} : { disabledReason: "Le service doit être en cours d'exécution." }),
    },
  ];
}
function onMenu(service: string, id: string) {
  if (id === "rule") ruleTarget.value = service;
  else if (id === "image") imageTarget.value = service;
}

onMounted(() => {
  void load();
  void loadRegistryHost();
  timer = window.setInterval(() => void load(), 4000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <button :disabled="stack.hostPresence === 'offline'" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="act('scans', 'Scans demandés.')">Scanner les images</button>
      <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="act('image-checks', 'Vérification lancée.')">Vérifier les mises à jour</button>
      <span v-if="busy" class="text-xs text-blue-700" aria-live="polite">Traitement en cours…</span>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <p v-if="stack.hostPresence === 'offline'" class="rounded bg-amber-50 p-3 text-sm text-amber-800">Agent hors ligne : les scans sont impossibles. Les résultats affichés sont les derniers connus, datés.</p>
    <section class="rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Évolution des CVE</h2>
      <p class="mb-2 text-xs text-slate-500">Par gravité, filtrée selon le seuil des paramètres ou non ; pour toute l'application ou un service.</p>
      <CveHistoryChart :stack-id="stack.id" :services="components.map((c) => c.service)" />
    </section>
    <p v-if="components.length === 0" class="text-sm text-slate-500">Aucune image observée : la stack n'est pas déployée ou l'hôte n'a pas encore remonté d'inventaire.</p>

    <article v-for="c in components" :key="c.service" class="space-y-4 rounded-lg border border-slate-300 bg-white p-4 shadow-sm">
      <header class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="flex items-start gap-2">
          <ToolsMenu v-if="session.canOperate" compact :label="`Actions de ${c.service}`" :items="menuItems(c.service)" @select="onMenu(c.service, $event)" />
          <div>
            <h2 class="font-semibold">{{ c.service }}</h2>
            <p class="font-mono text-xs text-slate-600">
              {{ c.ref }}
              <span v-if="isPatchedRef(c.ref, registryHost)" class="ml-1 rounded-full bg-green-100 px-2 py-0.5 font-sans text-[11px] font-medium text-green-800" title="Image corrigée par la console, hébergée dans votre registre privé et épinglée par digest">image corrigée</span>
            </p>
            <p class="text-xs text-slate-400">{{ c.image.platform || "plateforme inconnue" }} · {{ shortId(c.image.imageId) }}</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2"><UpdateBadge :check="c.check" /><ScanBadge :scan="c.image.scan" /></div>
      </header>

      <div v-if="c.image.scan.current?.total" class="text-sm">
        <div class="flex flex-wrap items-center gap-4">
          <button class="underline" :aria-expanded="!!open[c.service]" @click="open[c.service] = !open[c.service]">
            {{ open[c.service] ? "Masquer" : "Voir" }} les vulnérabilités
          </button>
          <span v-if="c.image.infrastructure" class="text-xs text-slate-600">Image d'infrastructure : pas de correctif local, mettez-la à jour vers une version officielle (« Vérifier les mises à jour »).</span>
          <button v-else-if="session.canOperate" class="inline-flex items-center gap-1 underline" title="Préparer une copie corrigée de cette image" @click="fixing = c.image">
            <FaIcon :icon="['fas', 'wrench']" /> Corriger l'image…
          </button>
        </div>
        <div v-if="open[c.service]" class="mt-3"><VulnerabilityTable :image-id="c.image.imageId" :platform="c.image.platform" :image-ref="c.ref" /></div>
      </div>

      <section class="space-y-2 border-t border-slate-100 pt-3 text-sm" aria-label="Versions disponibles">
        <h3 class="font-medium">Mises à jour de l'image</h3>
        <p v-if="!c.check" class="text-slate-500">Aucune vérification pour cette image (jamais faite, ou l'image a changé depuis). Les registres ne sont interrogés qu'à la demande ou selon la planification.</p>
        <template v-else>
          <p v-if="c.check.status === 'error'" role="alert" class="rounded bg-red-50 p-2 text-red-800">
            Vérification impossible : {{ c.check.error }}
            <template v-if="c.check.lastSuccessAt"> — dernière observation réussie {{ ago(c.check.lastSuccessAt) }} (conservée ci-dessous).</template>
            <template v-else> — aucune observation réussie pour l'instant : l'état est inconnu.</template>
          </p>
          <template v-if="c.check.detail">
            <p v-if="c.check.detail.built" class="rounded bg-slate-50 p-2 text-xs text-slate-700">
              Service personnalisé (construit sur l'hôte) : la vérification porte sur son <strong>image de base</strong>
              <template v-if="c.check.detail.ref"><code class="font-mono">{{ c.check.detail.ref }}</code></template>
              <template v-if="c.check.detail.built.dockerfile"> (ligne FROM de {{ c.check.detail.built.dockerfile }})</template>.
            </p>
            <p v-if="c.check.kind === 'up_to_date'" class="text-green-700">À jour : le tag « {{ c.check.detail.tag }} » pointe toujours vers le contenu déployé.</p>
            <p v-else-if="c.check.kind === 'pinned'" class="text-slate-600">Image épinglée par digest.</p>
            <p v-else-if="c.check.kind === 'local'" class="text-slate-600">Image locale : aucune comparaison avec un registre.</p>
            <template v-else-if="c.check.kind === 'update_available'">
              <div v-if="c.check.detail.contentChanged" class="flex flex-wrap items-center gap-3">
                <p class="text-amber-700">
                  Le tag « {{ c.check.detail.tag }} » pointe vers un nouveau contenu dans le registre.
                  <template v-if="c.check.detail.built">La mise à jour reconstruit l'image sur cette nouvelle base.</template>
                </p>
                <button v-if="canUpdate(c.service)" class="rounded border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100" @click="updateService = c.service">Mettre à jour…</button>
              </div>
              <div v-if="c.check.detail.candidates.length">
                <p class="text-amber-700">Versions plus récentes{{ c.check.detail.uncertain ? " (candidats incertains)" : "" }} :</p>
                <ul class="mt-1 flex flex-wrap gap-2">
                  <li v-for="t in c.check.detail.candidates" :key="t" class="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-mono text-xs text-amber-900">
                    {{ t }}
                    <button v-if="session.canOperate" class="rounded px-1 font-sans text-[11px] underline hover:bg-amber-200" :title="`Ne plus proposer ${t}`" @click="ignoreTag(c.service, t)">ignorer</button>
                  </li>
                </ul>
              </div>
              <p v-if="c.check.detail.built" class="text-xs text-slate-500">Rien n'est déployé automatiquement : utilisez « Comparer une autre version » puis « Utiliser cette version » (modifie la ligne FROM du Dockerfile), ou éditez-le dans l'onglet Configuration, puis déployez.</p>
              <p v-else class="text-xs text-slate-500">Rien n'est déployé automatiquement : modifiez le tag dans le Compose (onglet Configuration, section Compose) puis déployez.</p>
            </template>
            <ul v-if="c.check.detail.notes.length" class="list-disc space-y-0.5 pl-5 text-xs text-slate-600"><li v-for="n in c.check.detail.notes" :key="n">{{ n }}</li></ul>
            <p class="text-xs text-slate-400">
              Vérifié {{ ago(c.check.checkedAt) }} · déployé {{ c.check.detail.deployedDigest ? shortId(c.check.detail.deployedDigest) : "—" }}
              · registre {{ c.check.detail.remoteDigest ? shortId(c.check.detail.remoteDigest) : "—" }}
            </p>
          </template>
        </template>

        <p class="text-xs text-slate-500">
          Règle de suivi : {{ policyLabel(c.policy.policy) }}<template v-if="c.policy.policy === 'pattern' && c.policy.pattern"> (<code class="font-mono">{{ c.policy.pattern }}</code>)</template>
          <template v-if="c.ignoredTags.length"> · {{ c.ignoredTags.length }} version(s) ignorée(s)</template>
          — modifiable depuis le menu « … ».
        </p>
      </section>
      <CandidateCompare :stack-id="stack.id" :service="c.service" :refresh-key="c.check?.checkedAt ?? null" @changed="emit('changed')" />
      <p class="text-[11px] text-slate-400">Dernière tentative : {{ c.image.scan.lastAttempt ? fmtDate(c.image.scan.lastAttempt.finishedAt ?? c.image.scan.lastAttempt.createdAt) : "aucune" }}</p>
    </article>
    <DeployDialog
      v-if="updateService && stack.deployedRevision !== null"
      :stack="stack"
      :target="stack.deployedRevision"
      :update="{ service: updateService }"
      @close="updateService = null"
      @started="onUpdateStarted"
    />
    <OperationLog v-if="updateOperationId" :operation-id="updateOperationId" :stack-id="stack.id" @finished="onUpdateFinished" />
    <TrackingRuleDialog
      v-if="ruleComponent"
      :key="ruleComponent.service"
      :service="ruleComponent.service"
      :service-path="`/api/v1/stacks/${stack.id}/services/${encodeURIComponent(ruleComponent.service)}`"
      :policy="ruleComponent.policy.policy"
      :pattern="ruleComponent.policy.pattern"
      :ignored-tags="ruleComponent.ignoredTags"
      :can-operate="session.canOperate"
      @close="ruleTarget = null"
      @changed="load"
    />
    <CustomImageDialog
      v-if="imageTarget && imageContainer"
      :stack-id="stack.id"
      :host-id="stack.hostId"
      :revision="stack.currentRevision"
      :service="imageTarget"
      :container="imageContainer"
      @close="imageTarget = null"
      @saved="onImageSaved"
    />
    <RemediationDialog v-if="fixing" :image="fixing" @close="fixing = null; load()" @changed="emit('changed')" />
  </div>
</template>
