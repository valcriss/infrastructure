<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ago, api, describeError, fmtDate, shortId, type StackDetail, type StackImageComponent, type UpdatePolicyName } from "../../api";
import CandidateCompare from "../../components/CandidateCompare.vue";
import CustomImageDialog from "../../components/CustomImageDialog.vue";
import CveHistoryChart from "../../components/CveHistoryChart.vue";
import { useSession } from "../../stores/session";
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

const components = ref<StackImageComponent[]>([]);
const checking = ref(false);
const error = ref("");
const info = ref("");
const open = reactive<Record<string, boolean>>({});
const draft = reactive<Record<string, { policy: UpdatePolicyName; pattern: string }>>({});
let timer: number | undefined;

const policies: { key: UpdatePolicyName; label: string; help: string }[] = [
  { key: "same_tag", label: "Même tag uniquement", help: "Détecte seulement un nouveau contenu derrière le tag actuel." },
  { key: "patch", label: "Correctifs (1.2.x)", help: "Propose les versions plus récentes de même mineure." },
  { key: "minor", label: "Mineures (1.x)", help: "Propose les versions plus récentes de même majeure." },
  { key: "major", label: "Majeures", help: "Propose toute version plus récente." },
  { key: "pattern", label: "Expression libre", help: "Tags correspondant à une expression régulière (sans groupe répété)." },
];

async function load() {
  try {
    const r = await api<{ checking: boolean; components: StackImageComponent[] }>(`/api/v1/stacks/${props.stack.id}/images`);
    components.value = r.components;
    checking.value = r.checking;
    for (const c of r.components) draft[c.service] ??= { policy: c.policy.policy, pattern: c.policy.pattern ?? "" };
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

async function unignoreTag(service: string, tag: string) {
  error.value = info.value = "";
  try {
    await api(`/api/v1/stacks/${props.stack.id}/services/${encodeURIComponent(service)}/ignored-tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
    info.value = `La version « ${tag} » sera de nouveau proposée (vérification relancée).`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function savePolicy(service: string) {
  error.value = info.value = "";
  const d = draft[service];
  if (!d) return;
  try {
    await api(`/api/v1/stacks/${props.stack.id}/services/${encodeURIComponent(service)}/update-policy`, {
      method: "PUT",
      body: JSON.stringify({ policy: d.policy, pattern: d.policy === "pattern" ? d.pattern : null }),
    });
    info.value = `Règle de suivi de « ${service} » enregistrée (sauvegardée dans Git avec la stack).`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => {
  void load();
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

    <article v-for="c in components" :key="c.service" class="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <header class="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 class="font-semibold">{{ c.service }}</h2>
          <p class="font-mono text-xs text-slate-600">{{ c.ref }}</p>
          <p class="text-xs text-slate-400">{{ c.image.platform || "plateforme inconnue" }} · {{ shortId(c.image.imageId) }}</p>
        </div>
        <div><ScanBadge :scan="c.image.scan" /></div>
      </header>

      <div v-if="c.image.scan.current?.total" class="text-sm">
        <button class="underline" :aria-expanded="!!open[c.service]" @click="open[c.service] = !open[c.service]">
          {{ open[c.service] ? "Masquer" : "Voir" }} les vulnérabilités
        </button>
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
            <p v-if="c.check.kind === 'up_to_date'" class="text-green-700">À jour : le tag « {{ c.check.detail.tag }} » pointe toujours vers le contenu déployé.</p>
            <p v-else-if="c.check.kind === 'pinned'" class="text-slate-600">Image épinglée par digest.</p>
            <p v-else-if="c.check.kind === 'local'" class="text-slate-600">Image locale : aucune comparaison avec un registre.</p>
            <template v-else-if="c.check.kind === 'update_available'">
              <p v-if="c.check.detail.contentChanged" class="text-amber-700">Le tag « {{ c.check.detail.tag }} » pointe vers un nouveau contenu dans le registre.</p>
              <div v-if="c.check.detail.candidates.length">
                <p class="text-amber-700">Versions plus récentes{{ c.check.detail.uncertain ? " (candidats incertains)" : "" }} :</p>
                <ul class="mt-1 flex flex-wrap gap-2">
                  <li v-for="t in c.check.detail.candidates" :key="t" class="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-mono text-xs text-amber-900">
                    {{ t }}
                    <button v-if="session.canOperate" class="rounded px-1 font-sans text-[11px] underline hover:bg-amber-200" :title="`Ne plus proposer ${t}`" @click="ignoreTag(c.service, t)">ignorer</button>
                  </li>
                </ul>
              </div>
              <p class="text-xs text-slate-500">Rien n'est déployé automatiquement : modifiez le tag dans le Compose (onglet Configuration, section Compose) puis déployez.</p>
            </template>
            <ul v-if="c.check.detail.notes.length" class="list-disc space-y-0.5 pl-5 text-xs text-slate-600"><li v-for="n in c.check.detail.notes" :key="n">{{ n }}</li></ul>
            <p class="text-xs text-slate-400">
              Vérifié {{ ago(c.check.checkedAt) }} · déployé {{ c.check.detail.deployedDigest ? shortId(c.check.detail.deployedDigest) : "—" }}
              · registre {{ c.check.detail.remoteDigest ? shortId(c.check.detail.remoteDigest) : "—" }}
            </p>
          </template>
        </template>

        <div v-if="c.ignoredTags.length" class="border-t border-slate-100 pt-3 text-xs text-slate-600">
          <p class="font-medium">Versions ignorées (plus proposées)</p>
          <ul class="mt-1 space-y-1">
            <li v-for="i in c.ignoredTags" :key="i.tag" class="flex flex-wrap items-center gap-2">
              <span class="rounded bg-slate-100 px-2 py-0.5 font-mono">{{ i.tag }}</span>
              <span v-if="i.reason">{{ i.reason }}</span>
              <span class="text-slate-400">par {{ i.createdBy }}, {{ ago(i.createdAt) }}</span>
              <button v-if="session.canOperate" class="underline" @click="unignoreTag(c.service, i.tag)">Proposer de nouveau</button>
            </li>
          </ul>
        </div>

        <form class="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3" @submit.prevent="savePolicy(c.service)">
          <label class="text-xs">
            <span class="block font-medium">Règle de suivi</span>
            <select v-model="draft[c.service]!.policy" class="mt-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm" :aria-label="`Règle de suivi de ${c.service}`">
              <option v-for="p in policies" :key="p.key" :value="p.key" :title="p.help">{{ p.label }}</option>
            </select>
          </label>
          <label v-if="draft[c.service]?.policy === 'pattern'" class="text-xs">
            <span class="block font-medium">Expression</span>
            <input v-model="draft[c.service]!.pattern" placeholder="^v\d+\.\d+$" class="mt-1 rounded border border-slate-300 px-2 py-1.5 font-mono text-sm" />
          </label>
          <button class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">Enregistrer la règle</button>
          <span class="text-xs text-slate-400">{{ policies.find((p) => p.key === draft[c.service]?.policy)?.help }}</span>
        </form>
      </section>
      <CandidateCompare :stack-id="stack.id" :service="c.service" @changed="emit('changed')" />
      <div v-if="session.canOperate" class="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-sm">
        <button class="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100 disabled:opacity-50" :disabled="!stack.containers.some((x) => x.composeService === c.service && x.state === 'running')" @click="imageTarget = c.service">Créer une image personnalisée…</button>
        <span class="text-xs text-slate-500">Ajoute des outils ou applique les mises à jour du système (corrige les CVE du système qui ont un correctif).</span>
      </div>
      <p class="text-[11px] text-slate-400">Dernière tentative : {{ c.image.scan.lastAttempt ? fmtDate(c.image.scan.lastAttempt.finishedAt ?? c.image.scan.lastAttempt.createdAt) : "aucune" }}</p>
    </article>
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
  </div>
</template>
