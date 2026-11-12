<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  api, ago, describeError, fmtDate, shortId,
  type ImageView, type RemediationEligibility, type RemediationJob, type RemediationTarget,
} from "../api";
import { majorJump, STAGES, stageIndex, statusClass, statusLabel } from "../remediation";
import { useSession } from "../stores/session";
import CopyButton from "./CopyButton.vue";
import DiffView from "./DiffView.vue";

// Correctif d'une image : éligibilité, exécution suivie en direct, bilan avant / après, puis proposition de l'image
// corrigée à une application (nouvelle révision, jamais déployée ici). Voir docs/adr/0002-remediation-images.md.
const props = defineProps<{ image: ImageView }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const session = useSession();

const eligibility = ref<RemediationEligibility | null>(null);
const jobs = ref<RemediationJob[]>([]);
const job = ref<RemediationJob | null>(null);
const targets = ref<RemediationTarget[]>([]);
const registryReady = ref(true);
const hostId = ref("");
const error = ref("");
const info = ref("");
const busy = ref(false);
let timer: number | undefined;

const imageUrl = computed(() => `/api/v1/images/${encodeURIComponent(props.image.imageId)}`);
const label = computed(() => props.image.refs[0] ?? shortId(props.image.imageId));
const startHosts = computed(() => (eligibility.value?.hosts ?? []).filter((h) => h.online && h.capable));
const usable = computed(() => job.value !== null && !job.value.imageDeleted && (job.value.status === "validated" || job.value.status === "partial"));
const platformJobs = computed(() => jobs.value.filter((j) => j.platform === props.image.platform));

async function loadEligibility() {
  eligibility.value = await api<RemediationEligibility>(`${imageUrl.value}/remediation/eligibility?platform=${encodeURIComponent(props.image.platform)}`);
  if (!startHosts.value.some((h) => h.id === hostId.value)) hostId.value = startHosts.value[0]?.id ?? "";
}
async function loadJobs() {
  jobs.value = (await api<{ remediations: RemediationJob[] }>(`/api/v1/remediations?imageId=${encodeURIComponent(props.image.imageId)}&limit=30`)).remediations;
}
async function loadJob(id: string) {
  job.value = await api<RemediationJob>(`/api/v1/remediations/${id}`);
  if (usable.value) {
    try {
      const t = await api<{ targets: RemediationTarget[]; registryReady: boolean }>(`/api/v1/remediations/${id}/stack-targets`);
      targets.value = t.targets;
      registryReady.value = t.registryReady;
    } catch {
      targets.value = [];
    }
  } else {
    targets.value = [];
  }
}
async function refresh() {
  try {
    await Promise.all([loadEligibility(), loadJobs()]);
    const current = job.value?.id ?? eligibility.value?.activeJob?.id ?? platformJobs.value[0]?.id;
    if (current) await loadJob(current);
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(() => {
  void refresh();
  // Suivi en direct tant qu'un correctif est en cours.
  timer = window.setInterval(() => {
    if (job.value?.active) void refresh();
  }, 3000);
});
onBeforeUnmount(() => window.clearInterval(timer));

async function markReviewed() {
  if (!job.value) return;
  busy.value = true;
  try {
    job.value = await api<RemediationJob>(`/api/v1/remediations/${job.value.id}/review`, { method: "POST" });
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function start() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await api<{ remediationId: string }>(`${imageUrl.value}/remediations`, { method: "POST", body: JSON.stringify({ platform: props.image.platform, ...(hostId.value ? { hostId: hostId.value } : {}) }) });
    await refresh();
    await loadJob(r.remediationId);
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (!job.value) return;
  const unknown = job.value.status === "unknown";
  const running = job.value.status !== "queued" && !unknown;
  const text = unknown
    ? "Abandonner ce correctif ? Le résultat réel est inconnu : vérifiez d'abord le registre. Un tag de correctif déjà publié restera dans le registre."
    : running
      ? "Arrêter ce correctif en cours ? L'agent interrompt le travail et supprime ses conteneurs éphémères ; ce qu'il a déjà publié dans le registre y reste (images supprimables depuis Paramètres → Registry)."
      : "Annuler ce correctif en attente ?";
  if (!confirm(text)) return;
  busy.value = true;
  try {
    await api(`/api/v1/remediations/${job.value.id}/cancel`, { method: "POST" });
    await refresh();
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
async function open(id: string) {
  error.value = info.value = "";
  applying.value = null;
  try {
    await loadJob(id);
  } catch (err) {
    error.value = describeError(err);
  }
}

// --- Utiliser l'image corrigée ---------------------------------------------------------------------------
const applying = ref<RemediationTarget | null>(null);
const preview = ref<{ before: string; after: string; subject: "compose" | "variables"; variable: string | null } | null>(null);
const acceptPartial = ref(false);
const applyBody = (t: RemediationTarget) => ({ stackId: t.stackId, service: t.service, expectedRevision: t.currentRevision, ...(acceptPartial.value ? { acceptPartial: true } : {}) });

async function startApply(t: RemediationTarget) {
  error.value = info.value = "";
  applying.value = t;
  preview.value = null;
  acceptPartial.value = false;
  if (job.value?.status === "partial") return; // la confirmation précède l'aperçu
  await showPreview(t);
}
async function showPreview(t: RemediationTarget) {
  if (!job.value) return;
  try {
    preview.value = await api<{ before: string; after: string; subject: "compose" | "variables"; variable: string | null }>(`/api/v1/remediations/${job.value.id}/stack-revision/preview`, { method: "POST", body: JSON.stringify(applyBody(t)) });
  } catch (err) {
    error.value = describeError(err);
  }
}
async function confirmApply() {
  if (!job.value || !applying.value) return;
  const t = applying.value;
  busy.value = true;
  try {
    const r = await api<{ revision: number }>(`/api/v1/remediations/${job.value.id}/stack-revision`, { method: "POST", body: JSON.stringify(applyBody(t)) });
    info.value = `Révision ${r.revision} de « ${t.stackName} » enregistrée avec l'image corrigée pour « ${t.service} ». Elle n'est pas déployée : relisez-la puis déployez depuis l'application.`;
    applying.value = null;
    preview.value = null;
    await loadJob(job.value.id);
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const sevClass = (s: string): string => ({ CRITICAL: "text-red-700", HIGH: "text-orange-700", MEDIUM: "text-amber-700", LOW: "text-slate-600" })[s] ?? "text-slate-500";
const ghost = "rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50";
const primary = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`Corriger ${label}`" class="w-full max-w-4xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">Corriger l'image <span class="break-all font-mono text-base">{{ label }}</span></h2>
          <p class="text-xs text-slate-500">{{ image.platform || "plateforme inconnue" }} · {{ shortId(image.imageId) }} · l'image d'origine et les conteneurs en cours ne sont jamais modifiés, rien n'est déployé</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div class="space-y-5 p-6 text-sm">
        <p v-if="error" role="alert" class="rounded border border-red-300 bg-red-50 p-3 text-red-800">{{ error }}</p>
        <p v-if="info" role="status" class="rounded border border-green-300 bg-green-50 p-3 text-green-800">{{ info }}</p>

        <p v-if="image.updates.length" role="note" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Une version plus récente de cette image existe ({{ image.updates.map((u) => u.candidates.join(", ") || "nouveau contenu du même tag").join(" ; ") }}). Mettre à jour vers la version officielle est souvent préférable à un correctif local :
          vérifiez-la d'abord dans l'onglet « Sécurité et versions » de l'application.
        </p>

        <!-- Éligibilité -->
        <section aria-label="Éligibilité" class="rounded-lg border border-slate-200 p-4">
          <p v-if="!eligibility" class="text-slate-500">Analyse de l'image…</p>
          <template v-else>
            <p class="font-medium" :class="eligibility.eligible ? 'text-green-800' : 'text-slate-800'">{{ eligibility.message }}</p>
            <p class="mt-1 text-xs text-slate-500">
              {{ eligibility.fixableOs }} CVE avec correctif dans les paquets du système · {{ eligibility.fixableApp }} dans des dépendances applicatives (correction manuelle, hors correctif automatique) · {{ eligibility.unfixable }} sans correctif publié.
              Une CVE peut toucher plusieurs paquets : le bilan distingue CVE uniques et constats par paquet.
            </p>
            <p v-if="eligibility.eligible && !eligibility.registry.ready" class="mt-2 rounded bg-amber-50 p-2 text-amber-900">
              {{ eligibility.registry.reason }} <RouterLink to="/settings?tab=registry" class="underline" @click="emit('close')">Paramètres → Registry</RouterLink>
            </p>
            <p v-if="eligibility.eligible && eligibility.registry.ready && startHosts.length === 0 && !eligibility.activeJob" class="mt-2 rounded bg-amber-50 p-2 text-amber-900">
              Aucun hôte en ligne avec un agent à jour (capacité de correctif) ne porte cette image.
            </p>
            <div v-if="session.canOperate && eligibility.canStart" class="mt-3 flex flex-wrap items-end gap-3">
              <label v-if="startHosts.length > 1" class="text-xs">
                <span class="block font-medium">Hôte qui exécute le correctif</span>
                <select v-model="hostId" class="mt-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  <option v-for="h in startHosts" :key="h.id" :value="h.id">{{ h.name }}</option>
                </select>
              </label>
              <button :class="primary" :disabled="busy" @click="start"><FaIcon :icon="['fas', 'wrench']" /> Lancer le correctif</button>
              <p class="text-xs text-slate-500">L'agent copie l'image dans votre registre privé, la corrige (paquets du système uniquement), puis la vérifie par un nouveau scan.</p>
            </div>
          </template>
        </section>

        <!-- Historique -->
        <section v-if="platformJobs.length" aria-label="Historique des correctifs">
          <h3 class="mb-1 font-semibold">Correctifs de cette image</h3>
          <ul class="divide-y divide-slate-100 rounded-lg border border-slate-200">
            <li v-for="j in platformJobs" :key="j.id">
              <button class="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left hover:bg-slate-50" :class="job?.id === j.id ? 'bg-slate-50' : ''" @click="open(j.id)">
                <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusClass(j.status)]">{{ statusLabel(j.status) }}</span>
                <span class="font-mono text-xs">{{ j.patchedTag }}</span>
                <span class="text-xs text-slate-500" :title="fmtDate(j.createdAt)">{{ ago(j.createdAt) }} · {{ j.requestedBy }}</span>
                <span v-if="j.imageDeleted" class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">image supprimée du registre</span>
                <span v-if="j.applied.length" class="text-xs text-slate-500">· utilisée par {{ j.applied.map((a) => `${a.stackName}/${a.service}`).join(", ") }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- Détail du correctif -->
        <section v-if="job" aria-label="Détail du correctif" class="space-y-4 rounded-lg border border-slate-200 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-semibold">Correctif <span class="font-mono text-sm">{{ job.patchedTag }}</span> <span :class="['ml-2 rounded-full px-2 py-0.5 text-xs font-medium', statusClass(job.status)]">{{ statusLabel(job.status) }}</span></h3>
            <button v-if="session.canOperate && job.active" :class="ghost" :disabled="busy || job.cancelRequested" @click="cancel">{{ job.status === "unknown" ? "Abandonner" : job.status === "queued" ? "Annuler" : job.cancelRequested ? "Arrêt demandé…" : "Arrêter le correctif" }}</button>
          </div>

          <ol v-if="job.active && job.status !== 'unknown'" class="flex flex-wrap gap-2 text-xs" aria-label="Étapes">
            <li v-for="(s, n) in STAGES" :key="s.status" :class="['rounded-full px-3 py-1', n < stageIndex(job.status) ? 'bg-green-100 text-green-800' : n === stageIndex(job.status) ? 'bg-blue-600 font-medium text-white' : 'bg-slate-100 text-slate-500']" :aria-current="n === stageIndex(job.status) ? 'step' : undefined">{{ s.label }}</li>
          </ol>
          <p v-if="job.automatic" role="note" class="flex flex-wrap items-center gap-2 rounded border border-green-200 bg-green-50 p-2 text-xs text-green-900">
            Préparé automatiquement par la planification : rien n'a été appliqué ni déployé.
            <span v-if="job.reviewedAt" class="text-green-800">Relu par {{ job.reviewedBy }}.</span>
            <button v-else-if="session.canOperate && !job.active" :class="ghost" :disabled="busy" @click="markReviewed">Marquer comme relu</button>
          </p>
          <p v-if="job.active && job.status !== 'unknown'" class="text-xs text-slate-500">Suivi en direct.<template v-if="job.cancelRequested"> Arrêt demandé à l'agent : le correctif passe à « annulé » dès qu'il le confirme, sinon à « indéterminé » au bout de deux minutes.</template></p>

          <p v-if="job.status === 'unknown'" role="alert" class="rounded border border-orange-300 bg-orange-50 p-3 text-orange-900">{{ job.error }} Il n'est jamais relancé automatiquement.</p>
          <p v-else-if="job.status === 'failed' || job.status === 'cancelled'" role="alert" class="rounded border border-red-200 bg-red-50 p-3 text-red-800">{{ job.error }}</p>

          <template v-if="job.bilan">
            <p :class="['rounded border p-3', job.bilan.verdict === 'validated' ? 'border-green-300 bg-green-50 text-green-900' : job.bilan.verdict === 'partial' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-300 bg-red-50 text-red-900']" role="status">
              <strong>{{ job.bilan.verdict === "validated" ? "Validé" : job.bilan.verdict === "partial" ? "Partiel" : "Refusé" }}</strong>
              <template v-if="job.bilan.verdict === 'validated'"> — toutes les vulnérabilités corrigeables sont résolues, sans régression détectée.</template>
              <template v-for="r in job.bilan.reasons" :key="r"> {{ r }}</template>
            </p>

            <dl class="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div class="rounded border border-slate-200 p-2"><dt class="text-xs text-slate-500">CVE avant → après</dt><dd class="text-lg font-semibold">{{ job.bilan.cves.before }} → {{ job.bilan.cves.after }}</dd></div>
              <div class="rounded border border-slate-200 p-2"><dt class="text-xs text-slate-500">Corrigées</dt><dd class="text-lg font-semibold text-green-700">{{ job.bilan.cves.resolved }}</dd></div>
              <div class="rounded border border-slate-200 p-2"><dt class="text-xs text-slate-500">Corrigeables restantes</dt><dd class="text-lg font-semibold" :class="job.bilan.cves.remainingFixable ? 'text-amber-700' : ''">{{ job.bilan.cves.remainingFixable }}</dd></div>
              <div class="rounded border border-slate-200 p-2"><dt class="text-xs text-slate-500">Sans correctif publié</dt><dd class="text-lg font-semibold">{{ job.bilan.cves.unfixable }}</dd></div>
              <div class="rounded border border-slate-200 p-2"><dt class="text-xs text-slate-500">Nouvelles</dt><dd class="text-lg font-semibold" :class="job.bilan.cves.new ? 'text-red-700' : ''">{{ job.bilan.cves.new }}</dd></div>
            </dl>
            <p class="text-xs text-slate-500">CVE uniques. Constats par paquet : {{ job.bilan.findings.before }} avant, {{ job.bilan.findings.after }} après. « Sans correctif publié » : non corrigeable actuellement, ce n'est pas une acceptation de risque.</p>

            <details v-for="g in [{ k: 'resolved', t: 'CVE corrigées' }, { k: 'remaining', t: 'CVE restantes' }, { k: 'added', t: 'Nouvelles CVE' }] as const" :key="g.k" class="rounded border border-slate-200">
              <summary class="cursor-pointer px-3 py-1.5 font-medium">{{ g.t }} ({{ job.bilan[g.k].length }}{{ job.bilan.truncatedLists ? "+" : "" }})</summary>
              <div class="max-h-64 overflow-auto border-t border-slate-200">
                <table class="w-full text-left text-xs">
                  <tbody>
                    <tr v-for="v in job.bilan[g.k]" :key="v.id + v.pkg" class="border-b border-slate-100 last:border-0">
                      <td class="px-3 py-1 font-mono">{{ v.id }}</td>
                      <td class="px-3 py-1 font-medium" :class="sevClass(v.severity)">{{ v.severity }}</td>
                      <td class="px-3 py-1">{{ v.pkg }} {{ v.installed }}</td>
                      <td class="px-3 py-1 text-slate-500">{{ v.fixed ? `corrigé en ${v.fixed}` : "pas de correctif publié" }}</td>
                    </tr>
                    <tr v-if="job.bilan[g.k].length === 0"><td class="px-3 py-2 text-slate-500">Aucune.</td></tr>
                  </tbody>
                </table>
              </div>
            </details>

            <details v-if="job.packageChanges" class="rounded border border-slate-200">
              <summary class="cursor-pointer px-3 py-1.5 font-medium">Paquets modifiés ({{ job.packageChanges.length }})</summary>
              <p class="border-t border-slate-200 px-3 py-2 text-xs text-slate-600">Le moteur met chaque paquet à la <strong>dernière version disponible</strong>, pas seulement à la version minimale corrigée : relisez cette liste avant de l'utiliser.</p>
              <div class="max-h-64 overflow-auto border-t border-slate-200">
                <table class="w-full text-left text-xs">
                  <tbody>
                    <tr v-for="p in job.packageChanges" :key="p.name" class="border-b border-slate-100 last:border-0">
                      <td class="px-3 py-1 font-mono">{{ p.name }}</td>
                      <td class="px-3 py-1 text-slate-600">{{ p.from }} → {{ p.to }}</td>
                      <td class="px-3 py-1 text-amber-700">{{ majorJump(p.from, p.to) ? "changement de version majeure" : "" }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>

            <p class="text-xs text-slate-600">
              Configuration de l'image : <strong>{{ job.configChanges?.length ? "modifiée (" + job.configChanges.join(", ") + ")" : "inchangée" }}</strong>
              <template v-if="job.labelsAdded?.length"> · libellé(s) ajouté(s) : {{ job.labelsAdded.join(", ") }}</template>.
            </p>

            <section aria-label="Provenance" class="rounded bg-slate-50 p-3 text-xs text-slate-700">
              <p v-if="job.patchedRef" class="break-all"><strong>Référence immuable :</strong> <code class="font-mono">{{ job.patchedRef }}</code><CopyButton :text="job.patchedRef" label="Copier la référence" /></p>
              <p class="mt-1">Moteur Copa {{ job.tools?.copa ?? "?" }} · BuildKit {{ job.tools?.buildkit ?? "?" }} · Trivy {{ job.tools?.trivy ?? "?" }}<template v-if="job.vexStatements !== null"> · document VEX : {{ job.vexStatements }} déclaration(s)</template></p>
              <p class="mt-1">Source : <code class="font-mono">{{ job.sourceDigest ? shortId(job.sourceDigest) : "?" }}</code> → corrigée : <code class="font-mono">{{ job.patchedDigest ? shortId(job.patchedDigest) : "?" }}</code>. Terminé {{ job.finishedAt ? ago(job.finishedAt) : "?" }}.</p>
            </section>
            <p role="note" class="rounded border border-slate-200 p-3 text-xs text-slate-600">
              Un scan favorable atteste la <strong>sécurité de l'image</strong>, pas le bon fonctionnement de l'application : testez l'image corrigée avant de la déployer en production.
              Elle est tirée du registre privé par les hôtes concernés ; seul l'hôte qui l'a construite l'a téléchargée pendant ce contrôle.
            </p>
          </template>

          <!-- Utiliser l'image corrigée -->
          <section v-if="usable && job.patchedRef" aria-label="Utiliser l'image corrigée" class="space-y-3 border-t border-slate-100 pt-4">
            <h3 class="font-semibold">Utiliser l'image corrigée</h3>
            <p class="text-xs text-slate-500">Crée une <strong>nouvelle révision non déployée</strong> qui ne change que l'image du service (ou, si l'image est portée par une variable de la stack, que cette variable). Le déploiement reste une action explicite de l'application. Un service épinglé sur cette image n'est plus suivi par la détection de nouvelles étiquettes : relancez un correctif quand l'image officielle change.</p>
            <p v-if="!targets.length" class="text-slate-500">Aucun service d'une application gérée n'utilise actuellement cette image.</p>
            <ul v-else class="divide-y divide-slate-100 rounded-lg border border-slate-200">
              <li v-for="t in targets" :key="t.stackId + t.service" class="flex flex-wrap items-center gap-3 px-3 py-2">
                <div class="min-w-0 flex-1">
                  <RouterLink :to="`/stacks/${t.stackId}`" class="font-medium underline" @click="emit('close')">{{ t.stackName }}/{{ t.service }}</RouterLink>
                  <span class="text-xs text-slate-500"> · {{ t.hostName }} · révision {{ t.currentRevision }}{{ t.deployedRevision === t.currentRevision ? " (déployée)" : "" }}</span>
                  <p v-if="t.mode === 'variable'" class="text-xs text-slate-500">Image portée par la variable <code class="font-mono">{{ t.variable }}</code> : seule cette variable changera, le Compose reste identique.</p>
                  <p v-if="t.reason" class="text-xs" :class="t.alreadyApplied ? 'text-green-700' : 'text-amber-700'">{{ t.reason }}</p>
                </div>
                <button v-if="session.canOperate && t.canApply" :class="ghost" :disabled="busy" @click="startApply(t)">Utiliser l'image corrigée</button>
              </li>
            </ul>

            <div v-if="applying" class="space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
              <p class="font-medium">{{ applying.stackName }}/{{ applying.service }} : <code class="font-mono text-xs">{{ applying.mode === 'variable' ? `${applying.variable} = ${applying.effectiveImage ?? '(aucune valeur)'}` : applying.currentImage }}</code> → image corrigée</p>
              <label v-if="job.status === 'partial'" class="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
                <input v-model="acceptPartial" type="checkbox" class="mt-1" @change="acceptPartial ? showPreview(applying) : (preview = null)" />
                <span>Je comprends que des vulnérabilités corrigeables subsistent dans cette image (verdict « partiel ») et je veux quand même l'utiliser.</span>
              </label>
              <p v-if="preview?.subject === 'variables'" class="text-xs text-slate-600">Variables de l'application (les valeurs sensibles sont masquées) : le fichier Compose n'est pas modifié.</p>
              <DiffView v-if="preview" :before="preview.before" :after="preview.after" />
              <div class="flex flex-wrap gap-2">
                <button :class="primary" :disabled="busy || !preview" @click="confirmApply">Créer la révision (sans déployer)</button>
                <button :class="ghost" :disabled="busy" @click="applying = null; preview = null">Annuler</button>
              </div>
            </div>
          </section>
        </section>
      </div>
    </div>
  </div>
</template>
