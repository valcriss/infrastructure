<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { ago, api, describeError, fmtDate, shortId, type ImageView, type RemediationJob } from "../api";
import RemediationDialog from "../components/RemediationDialog.vue";
import { latestByImage, statusClass, statusLabel } from "../remediation";
import { useSession } from "../stores/session";
import ScanAllDialog, { type BatchResult } from "../components/ScanAllDialog.vue";
import SeverityBadges from "../components/SeverityBadges.vue";
import VulnerabilityTable from "../components/VulnerabilityTable.vue";

const images = ref<ImageView[]>([]);
const session = useSession();
// Correctifs d'images (remédiation) : le plus récent par contenu d'image, et l'image dont le dialogue est ouvert.
const jobs = ref<RemediationJob[]>([]);
const latestJob = computed(() => latestByImage(jobs.value));
const fixing = ref<ImageView | null>(null);
const error = ref("");
const info = ref("");
const route = useRoute();
const filter = ref<"" | "managed" | "never" | "vulnerable" | "failed" | "updates">(route.query.filter === "updates" ? "updates" : "");
const search = ref("");
const open = reactive<Record<string, boolean>>({});
const queue = ref<{ pending: number; running: number; current: { imageRef: string; startedAt: string } | null }>({ pending: 0, running: 0, current: null });
const scanAll = ref(false);
// Plus grand nombre de scans en file depuis l'apparition de la bannière : sert à la barre de progression.
const peak = ref(0);
let timer: number | undefined;

const key = (i: ImageView) => `${i.imageId}|${i.platform}`;
const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  return images.value.filter((i) => {
    if (q && !i.refs.some((r) => r.toLowerCase().includes(q)) && !i.imageId.includes(q)) return false;
    if (filter.value === "managed") return i.managed;
    if (filter.value === "updates") return i.updates.length > 0;
    if (filter.value) return i.scan.state === filter.value;
    return true;
  });
});
// Tri (un clic sur un en-tête : croissant, deuxième clic : décroissant), comme sur les autres écrans.
type SortKey = "image" | "usedBy" | "vulns" | "scan";
const sortKey = ref<SortKey>("image");
const sortDir = ref<1 | -1>(1);
function sortBy(k: SortKey) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortKey.value = k;
    sortDir.value = k === "image" || k === "usedBy" ? 1 : -1;
  }
}
const label = (i: ImageView): string => (i.refs[0] ?? shortId(i.imageId)).toLowerCase();
function sortValue(i: ImageView, k: SortKey): string | number {
  switch (k) {
    case "image": return label(i);
    case "usedBy": return i.usedBy.map((u) => (u.stackName ? `${u.stackName}/${u.service ?? ""}` : u.container)).sort()[0]?.toLowerCase() ?? "";
    // Gravité d'abord (critiques, puis élevées…) ; jamais scannée ou en échec : tout en bas.
    case "vulns": {
      const c = i.scan.current?.counts;
      return c ? c.critical * 1e9 + c.high * 1e6 + c.medium * 1e3 + c.low : -1;
    }
    case "scan": return i.scan.current?.finishedAt ? Date.parse(i.scan.current.finishedAt) || -1 : -1;
  }
}
const sorted = computed(() =>
  [...shown.value].sort((x, y) => {
    const a = sortValue(x, sortKey.value);
    const b = sortValue(y, sortKey.value);
    const c = a < b ? -1 : a > b ? 1 : 0;
    return c * sortDir.value || label(x).localeCompare(label(y)) || x.platform.localeCompare(y.platform);
  }),
);
const columns = [
  { key: "image", label: "Image", cls: "" },
  { key: "usedBy", label: "Utilisée par", cls: "hidden md:table-cell" },
  { key: "vulns", label: "Vulnérabilités", cls: "" },
  { key: "scan", label: "Dernier scan", cls: "hidden lg:table-cell" },
] as const;

const critical = computed(() => images.value.reduce((n, i) => n + (i.scan.current?.counts?.critical ?? 0), 0));
const updatesCount = computed(() => images.value.filter((i) => i.updates.length > 0).length);
const high = computed(() => images.value.reduce((n, i) => n + (i.scan.current?.counts?.high ?? 0), 0));

async function load() {
  try {
    const r = await api<{ queue?: { pending: number; running: number; current: { imageRef: string; startedAt: string } | null }; images: ImageView[] }>("/api/v1/images");
    images.value = r.images;
    queue.value = r.queue ?? { pending: 0, running: 0, current: null };
    const active = queue.value.pending + queue.value.running;
    peak.value = active === 0 ? 0 : Math.max(peak.value, active);
    error.value = "";
    // Les correctifs sont un complément : leur absence ne doit pas masquer la liste des images.
    jobs.value = (await api<{ remediations: RemediationJob[] }>("/api/v1/remediations?limit=200").catch(() => ({ remediations: [] as RemediationJob[] }))).remediations;
  } catch (err) {
    error.value = describeError(err);
  }
}
async function scan(i: ImageView) {
  error.value = info.value = "";
  try {
    await api(`/api/v1/images/${encodeURIComponent(i.imageId)}/scans`, { method: "POST", body: JSON.stringify({ platform: i.platform || undefined }) });
    info.value = `Scan de ${i.refs[0] ?? shortId(i.imageId)} demandé.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function onStarted(r: BatchResult) {
  scanAll.value = false;
  info.value = `${r.requested} scan(s) mis en file (un à la fois)${r.alreadyQueued ? `, ${r.alreadyQueued} déjà en file` : ""}${r.skippedOffline ? `, ${r.skippedOffline} ignoré(s) : hôte hors ligne` : ""}.`;
  await load();
}

// Un scan dure de quelques secondes à quelques minutes : au-delà de 10 minutes, il est probablement perdu.
const runningMinutes = computed(() => (queue.value.current ? Math.max(0, Math.round((Date.now() - Date.parse(queue.value.current.startedAt)) / 60_000)) : 0));
const looksStuck = computed(() => queue.value.running > 0 && runningMinutes.value >= 10);

async function unblock() {
  if (!confirm("Déclarer perdu le scan en cours et reprendre la file ? Si l'agent le terminait quand même, son résultat serait ignoré.")) return;
  try {
    const r = await api<{ removed: number; interrupted: number }>("/api/v1/images/scans/queue?only=running", { method: "DELETE" });
    info.value = `File débloquée : ${r.interrupted} scan(s) en cours interrompu(s), les ${queue.value.pending} en attente reprennent.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function cancelQueue() {
  if (!confirm(`Annuler les ${queue.value.pending} scan(s) en attente ? Celui en cours ira à son terme.`)) return;
  try {
    const r = await api<{ removed: number }>("/api/v1/images/scans/queue", { method: "DELETE" });
    info.value = `${r.removed} scan(s) retiré(s) de la file.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Images</h1>
        <p class="text-sm text-slate-500">
          {{ images.length }} image(s) · <span :class="critical ? 'font-medium text-red-600' : ''">{{ critical }} critique(s)</span> · {{ high }} élevée(s)
          · <span :class="updatesCount ? 'font-medium text-amber-700' : ''">{{ updatesCount }} avec mise à jour</span>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <button class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700" @click="scanAll = true">
          <FaIcon :icon="['fas', 'shield-halved']" /> Scanner tout…
        </button>
        <label class="relative">
          <span class="sr-only">Rechercher</span>
          <FaIcon :icon="['fas', 'magnifying-glass']" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input v-model="search" type="search" placeholder="Rechercher une image" class="w-64 rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-3" />
        </label>
        <select v-model="filter" aria-label="Filtre" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
          <option value="">Toutes les images</option>
          <option value="updates">Avec mise à jour disponible</option>
          <option value="managed">Images d'applications gérées</option>
          <option value="never">Jamais scannées</option>
          <option value="failed">Scan en échec</option>
          <option value="vulnerable">Avec vulnérabilités</option>
        </select>
      </div>
    </div>
    <section v-if="queue.pending + queue.running > 0" class="rounded-xl border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900" role="status" aria-live="polite">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="flex items-center gap-2 font-medium">
          <FaIcon :icon="['fas', 'arrows-rotate']" spin />
          Scans : {{ queue.running }} en cours, {{ queue.pending }} en attente — un à la fois
        </p>
        <div class="flex flex-wrap gap-2">
          <button v-if="queue.running > 0" :class="['rounded-md border px-3 py-1 hover:bg-white', looksStuck ? 'border-amber-500 bg-amber-100 font-medium text-amber-900' : 'border-blue-400']" @click="unblock">Débloquer la file</button>
          <button v-if="queue.pending > 0" class="rounded-md border border-blue-400 px-3 py-1 hover:bg-white" @click="cancelQueue">Annuler la file d'attente</button>
        </div>
      </div>
      <p v-if="queue.current" class="mt-1 text-xs">
        En cours : <span class="font-mono">{{ queue.current.imageRef }}</span> depuis {{ runningMinutes < 1 ? "moins d'une minute" : `${runningMinutes} min` }}.
        <span v-if="looksStuck" class="font-medium text-amber-800">Ce scan dure anormalement longtemps : s'il est perdu (agent redémarré, application mise à jour…), utilisez « Débloquer la file ».</span>
      </p>
      <div class="mt-2 h-2 overflow-hidden rounded-full bg-white" role="progressbar" aria-label="Progression des scans" aria-valuemin="0" :aria-valuemax="peak" :aria-valuenow="peak - queue.pending - queue.running">
        <div class="h-full rounded-full bg-blue-600 transition-all duration-700" :style="{ width: `${peak ? ((peak - queue.pending - queue.running) / peak) * 100 : 0}%` }"></div>
      </div>
      <p class="mt-1 text-xs">{{ Math.max(0, peak - queue.pending - queue.running) }} terminé(s) sur {{ peak }} depuis le lancement.</p>
    </section>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>

    <section aria-label="Images" class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <p v-if="shown.length === 0" class="p-6 text-sm text-slate-500">Aucune image. Elles apparaissent dès que des conteneurs sont observés sur un hôte.</p>
      <table v-else class="w-full min-w-[720px] text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
          <tr>
            <th v-for="col in columns" :key="col.key" scope="col" :class="['px-3 py-2 font-medium', col.cls]" :aria-sort="sortKey === col.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'">
              <button type="button" class="inline-flex items-center gap-1 hover:text-slate-900" @click="sortBy(col.key)">
                {{ col.label }}
                <FaIcon v-if="sortKey === col.key" :icon="['fas', sortDir === 1 ? 'chevron-up' : 'chevron-down']" class="text-[10px]" />
              </button>
            </th>
            <th scope="col" class="px-3 py-2 text-right"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="i in sorted" :key="key(i)">
            <tr class="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50">
              <td class="px-3 py-2">
                <p class="flex items-center gap-2 break-all font-mono font-medium">
                  <FaIcon :icon="['fas', 'layer-group']" class="text-slate-400" />{{ i.refs[0] ?? shortId(i.imageId) }}
                </p>
                <p class="mt-0.5 text-xs text-slate-400">
                  {{ i.platform || "plateforme inconnue" }} · {{ shortId(i.imageId) }}<span v-if="!i.managed"> · hors application gérée</span>
                </p>
                <p v-if="latestJob.get(key(i))" class="mt-1.5 text-xs">
                  <button class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium" :class="statusClass(latestJob.get(key(i))!.status)" :title="`Correctif ${latestJob.get(key(i))!.patchedTag} : voir le détail`" @click="fixing = i">
                    <FaIcon :icon="['fas', 'wrench']" /> Correctif : {{ statusLabel(latestJob.get(key(i))!.status) }}
                  </button>
                </p>
                <div v-if="i.updates.length" class="mt-1.5 space-y-0.5 text-xs">
                  <p class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                    <FaIcon :icon="['fas', 'arrows-rotate']" /> Mise à jour disponible
                  </p>
                  <p v-for="u in i.updates" :key="u.service" class="text-amber-800">
                    {{ u.service }} :
                    <template v-if="u.contentChanged">nouveau contenu pour le tag « {{ u.tag }} »</template>
                    <template v-if="u.contentChanged && u.candidates.length"> ; </template>
                    <template v-if="u.candidates.length">plus récent : {{ u.candidates.join(", ") }}{{ u.uncertain ? " (incertain)" : "" }}</template>
                    <RouterLink v-if="u.stackId" :to="`/stacks/${u.stackId}`" class="ml-1 underline">Voir</RouterLink>
                  </p>
                </div>
              </td>
              <td class="hidden px-3 py-2 text-xs text-slate-600 md:table-cell">
                <template v-for="(u, n) in i.usedBy" :key="u.containerId + u.hostId">
                  <template v-if="n">, </template>
                  <RouterLink v-if="u.stackId" :to="`/stacks/${u.stackId}`" class="underline">{{ u.stackName }}/{{ u.service }}</RouterLink>
                  <span v-else>{{ u.container }}</span>
                  <span class="text-slate-400"> ({{ u.hostName }}{{ u.state !== "running" ? ", " + u.state : "" }})</span>
                </template>
              </td>
              <td class="px-3 py-2">
                <SeverityBadges :state="i.scan.state" :counts="i.scan.current?.counts ?? null" :stale="i.scan.stale" :hidden="i.scan.current?.hidden" :position="i.scan.queuePosition" />
                <p v-if="i.scan.current?.hidden" class="mt-1 text-xs text-slate-500">{{ i.scan.current.hidden }} sous le seuil, masquée(s)</p>
                <p v-if="i.scan.state === 'failed'" class="mt-1 max-w-xs text-xs text-red-700">{{ i.scan.lastAttempt?.error }}</p>
                <p v-if="i.scan.current?.os?.eosl" class="mt-1 text-xs text-amber-700">{{ i.scan.current.os.family }} {{ i.scan.current.os.name }} en fin de vie</p>
              </td>
              <td class="hidden px-3 py-2 text-xs text-slate-500 lg:table-cell">
                <template v-if="i.scan.current">
                  <span :title="fmtDate(i.scan.current.finishedAt)">{{ ago(i.scan.current.finishedAt) }}</span>
                  <p>Trivy {{ i.scan.current.trivyVersion ?? "?" }} · base du {{ i.scan.current.dbUpdatedAt ? new Date(i.scan.current.dbUpdatedAt).toLocaleDateString("fr-FR") : "?" }}</p>
                </template>
                <template v-else>—</template>
              </td>
              <td class="px-3 py-2 text-right">
                <div class="flex justify-end gap-2 text-xs">
                  <button v-if="i.scan.current?.total" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" :aria-expanded="!!open[key(i)]" @click="open[key(i)] = !open[key(i)]">
                    {{ open[key(i)] ? "Masquer" : "Détails" }}
                  </button>
                  <button v-if="session.canOperate && i.scan.current?.total" class="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" title="Préparer une copie corrigée de cette image" @click="fixing = i">
                    <FaIcon :icon="['fas', 'wrench']" /> Corriger
                  </button>
                  <button class="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="scan(i)">
                    <FaIcon :icon="['fas', 'shield-halved']" /> Scanner
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="open[key(i)]" class="border-b border-slate-100 bg-slate-50 last:border-0">
              <td colspan="5" class="px-3 py-4"><VulnerabilityTable :image-id="i.imageId" :platform="i.platform" :image-ref="i.refs[0]" /></td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <p class="text-sm text-slate-500">
      La périodicité des scans et les registres d'images se règlent dans
      <RouterLink to="/settings?tab=security" class="text-blue-600 underline">Paramètres de l'application</RouterLink>.
    </p>
    <ScanAllDialog v-if="scanAll" @close="scanAll = false" @started="onStarted" />
    <RemediationDialog v-if="fixing" :image="fixing" @close="fixing = null; load()" @changed="load" />
  </div>
</template>
