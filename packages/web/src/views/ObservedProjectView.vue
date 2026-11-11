<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { ApiError, ago, api, describeError, fmtDate, formatBytes, type Application, type Container } from "../api";
import CopyButton from "../components/CopyButton.vue";
import CveHistoryChart from "../components/CveHistoryChart.vue";
import MeterBar from "../components/MeterBar.vue";
import PanelCard from "../components/PanelCard.vue";
import SeverityBadges from "../components/SeverityBadges.vue";
import VulnerabilityTable from "../components/VulnerabilityTable.vue";
import LogsTab from "./stack/LogsTab.vue";
import VersionsTab from "./stack/VersionsTab.vue";
import TerminalPanel from "../components/TerminalPanel.vue";
import { useSession } from "../stores/session";
import MetricsTab from "./stack/MetricsTab.vue";

// Fiche en lecture seule d'un projet Compose qui tourne sur un hôte sans être géré par la console.
const route = useRoute();
const hostId = computed(() => String(route.params.hostId));
const name = computed(() => String(route.params.name));

const app = ref<Application | null>(null);
const containers = ref<Container[]>([]);
const error = ref("");
const info = ref("");
const now = ref(Date.now());
// ?tab=… ouvre directement un onglet (lien d'alerte du tableau de bord).
const tab = ref(["overview", "security", "versions", "metrics", "logs", "terminal"].includes(String(route.query.tab)) ? String(route.query.tab) : "overview");
const open = reactive<Record<string, boolean>>({});
let timer: number | undefined;

const session = useSession();
const TABS = computed(() => [
  { key: "overview", label: "Vue d'ensemble", icon: "gauge-high" },
  { key: "security", label: "Sécurité", icon: "shield-halved" },
  { key: "versions", label: "Versions", icon: "code-branch" },
  { key: "metrics", label: "Métriques", icon: "chart-line" },
  { key: "logs", label: "Logs", icon: "terminal" },
  ...(session.info?.terminalAllowed ? [{ key: "terminal", label: "Terminal", icon: "terminal" }] : []),
]);

async function load() {
  try {
    const r = await api<{ application: Application; containers: Container[] }>(`/api/v1/hosts/${hostId.value}/projects/${encodeURIComponent(name.value)}`);
    app.value = r.application;
    containers.value = r.containers;
    now.value = Date.now();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError && err.status === 404 ? "Ce projet n'est plus observé sur cet hôte." : describeError(err);
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const STATUS = {
  running: { text: "En marche", cls: "bg-green-100 text-green-800" },
  degraded: { text: "Dégradée", cls: "bg-red-100 text-red-800" },
  stopped: { text: "Arrêtée", cls: "bg-slate-200 text-slate-700" },
  unknown: { text: "Inconnue", cls: "bg-amber-100 text-amber-800" },
  not_deployed: { text: "Jamais déployée", cls: "bg-blue-100 text-blue-800" },
} as const;

const origin = computed(() => containers.value.find((c) => c.composeWorkingDir || c.composeConfigFiles) ?? null);
const stackLike = computed(() => ({ id: "", containers: containers.value, hostPresence: app.value?.hostPresence ?? ("online" as const) }));
const project = computed(() => ({ hostId: hostId.value, name: name.value }));

const portText = (c: Container): string =>
  (c.ports ?? []).map((p) => (p.publicPort ? `${p.publicPort}→${p.privatePort}/${p.type}` : `${p.privatePort}/${p.type}`)).join(", ") || "—";

const stateText = (c: Container): string => (c.state === "exited" && c.exitCode !== undefined ? `exited (${c.exitCode})` : c.state);
const stateCls = (c: Container): string =>
  c.state === "running" ? "text-green-700" : c.state === "exited" && c.exitCode === 0 ? "text-slate-500" : "text-red-700";

async function scan(imageId: string, platform: string, ref: string) {
  error.value = info.value = "";
  try {
    await api(`/api/v1/images/${encodeURIComponent(imageId)}/scans`, { method: "POST", body: JSON.stringify({ platform: platform || undefined }) });
    info.value = `Scan de ${ref} demandé.`;
    window.setTimeout(() => void load(), 1500);
  } catch (err) {
    error.value = describeError(err);
  }
}
</script>

<template>
  <div class="space-y-6">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <template v-if="app">
      <div>
        <RouterLink to="/stacks" class="text-sm text-slate-500 hover:underline">← Applications</RouterLink>
        <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 class="flex items-center gap-3 text-2xl font-semibold">
            <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-lg text-slate-500"><FaIcon :icon="['fas', 'eye']" /></span>
            {{ app.name }}
            <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', STATUS[app.status].cls]" :title="app.reason">{{ STATUS[app.status].text }}</span>
          </h1>
          <RouterLink v-if="app.importable" :to="{ path: '/stacks/new', query: { adopt: '1', host: app.hostId, name: app.name } }" class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <FaIcon :icon="['fas', 'download']" /> Prendre en charge
          </RouterLink>
        </div>
        <p class="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
          <FaIcon :icon="['fas', 'server']" /> {{ app.hostName }}<span v-if="app.hostPresence === 'offline'" class="rounded bg-red-100 px-1.5 text-red-800">hors ligne</span>
          · {{ app.containers.running }}/{{ app.containers.total }} conteneur(s) en marche
        </p>
      </div>

      <div role="note" class="flex items-start gap-3 rounded-xl border-2 border-dashed border-slate-300 p-4 text-sm text-slate-600">
        <FaIcon :icon="['fas', 'circle-info']" class="mt-0.5 text-slate-400" />
        <p>
          Application <strong>observée</strong> : elle tourne sur l'hôte sans que la console ait son fichier Compose. Cette fiche est en lecture seule (aucun démarrage, arrêt ni
          modification) ; les variables d'environnement des conteneurs ne sont jamais lues. « Prendre en charge » permet de la gérer depuis la console.
        </p>
      </div>

      <div role="tablist" aria-label="Sections du projet" class="flex flex-wrap gap-1 border-b border-slate-200">
        <button
          v-for="t in TABS"
          :key="t.key"
          role="tab"
          :aria-selected="tab === t.key"
          class="-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm"
          :class="tab === t.key ? 'border-blue-600 font-medium text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'"
          @click="tab = t.key"
        >
          <FaIcon :icon="['fas', t.icon]" /> {{ t.label }}
        </button>
      </div>

      <template v-if="tab === 'overview'">
        <div class="grid items-start gap-4 xl:grid-cols-3">
          <PanelCard title="État" icon="heart-pulse">
            <p class="text-sm text-slate-600">{{ app.reason }}</p>
            <div v-if="app.usage" class="mt-4 space-y-2">
              <MeterBar label="CPU" icon="microchip" :percent="Math.min(100, app.usage.cpuPercent)" :detail="`${app.usage.cpuPercent.toFixed(1)} % d'un cœur`" />
              <p class="flex items-center gap-1.5 text-xs text-slate-600"><FaIcon :icon="['fas', 'memory']" class="text-slate-400" /> Mémoire : <span class="font-medium tabular-nums">{{ formatBytes(app.usage.memBytes) }}</span></p>
            </div>
          </PanelCard>
          <PanelCard title="Origine Compose" icon="code-branch" subtitle="D'après les libellés Docker des conteneurs (chemins de l'hôte)" class="xl:col-span-2">
            <dl v-if="origin" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-slate-500">Dossier du projet</dt>
              <dd class="break-all font-mono text-xs">{{ origin.composeWorkingDir ?? "inconnu" }}<CopyButton v-if="origin.composeWorkingDir" :text="origin.composeWorkingDir" label="Copier le dossier du projet" /></dd>
              <dt class="font-medium text-slate-700">Compose d'origine</dt>
              <dd class="break-all font-mono text-xs font-semibold">{{ origin.composeConfigFiles ?? "inconnu" }}<CopyButton v-if="origin.composeConfigFiles" :text="origin.composeConfigFiles" label="Copier le chemin du fichier Compose" /></dd>
            </dl>
            <p v-else class="text-sm text-slate-500">Ce projet n'indique pas l'emplacement de son fichier Compose.</p>
            <p class="mt-3 text-xs text-slate-500">
              Le contenu de ce fichier n'est pas lu : il n'est pas visible par l'agent. Ouvrez-le sur l'hôte (chemins ci-dessus), puis collez-le dans « Prendre en charge » : c'est lui, et non un squelette reconstruit, qui doit servir de base.
            </p>
          </PanelCard>
        </div>

        <section aria-label="Conteneurs" class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table class="w-full text-left text-sm">
            <thead class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr><th class="px-4 py-3">Service</th><th class="px-4 py-3">Image</th><th class="px-4 py-3">État</th><th class="px-4 py-3">Ports</th><th class="px-4 py-3">Réseaux</th><th class="px-4 py-3">Redémarrages</th></tr>
            </thead>
            <tbody>
              <template v-for="c in containers" :key="c.id">
                <tr class="border-t border-slate-100 align-top">
                  <td class="px-4 py-3">
                    <p class="font-medium">{{ c.composeService ?? c.names[0] }}</p>
                    <p class="text-xs text-slate-400">{{ c.names[0] }} · {{ c.id.slice(0, 12) }}</p>
                  </td>
                  <td class="px-4 py-3 font-mono text-xs">{{ c.image }}</td>
                  <td class="px-4 py-3">
                    <span :class="stateCls(c)">{{ stateText(c) }}</span>
                    <p class="text-xs text-slate-500">{{ c.status }}</p>
                    <p v-if="c.state === 'running' && c.health && c.health !== 'none'" :class="['text-xs', c.health === 'unhealthy' ? 'text-red-700' : 'text-slate-500']">healthcheck : {{ c.health }}</p>
                  </td>
                  <td class="px-4 py-3 font-mono text-xs">{{ portText(c) }}</td>
                  <td class="px-4 py-3 text-xs">{{ (c.networks ?? []).join(", ") || "—" }}</td>
                  <td class="px-4 py-3 text-xs tabular-nums">{{ c.restartCount ?? 0 }}</td>
                </tr>
                <tr v-if="c.mounts?.length" class="bg-slate-50">
                  <td colspan="6" class="px-4 py-2 text-xs text-slate-600">
                    <button class="underline" :aria-expanded="!!open[c.id]" @click="open[c.id] = !open[c.id]">{{ open[c.id] ? "Masquer" : "Voir" }} les {{ c.mounts.length }} montage(s)</button>
                    <ul v-if="open[c.id]" class="mt-2 space-y-1 font-mono">
                      <li v-for="m in c.mounts" :key="m.destination">
                        <span class="text-slate-400">{{ m.type }}</span> {{ m.source ?? "?" }} → {{ m.destination }} <span class="text-slate-400">({{ m.rw ? "lecture-écriture" : "lecture seule" }})</span>
                      </li>
                    </ul>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>
      </template>

      <template v-else-if="tab === 'security'">
        <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
        <PanelCard title="Évolution des CVE" icon="chart-line" subtitle="Par gravité, filtrée selon le seuil des paramètres ou non ; pour toute l'application ou un service">
          <CveHistoryChart :host-id="app.hostId" :project="app.name" :services="app.services" />
        </PanelCard>
        <PanelCard title="Images du projet" icon="layer-group" subtitle="Vulnérabilités selon le seuil de gravité des paramètres de l'application">
          <p v-if="app.images.length === 0" class="text-sm text-slate-500">Aucune image observée.</p>
          <ul class="divide-y divide-slate-200">
            <li v-for="i in app.images" :key="i.imageId + i.platform" class="py-3 first:pt-0 last:pb-0">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="flex items-center gap-2 font-mono text-sm"><FaIcon :icon="['fas', 'layer-group']" class="text-slate-400" /> {{ i.ref }}</span>
                <div class="flex items-center gap-3">
                  <SeverityBadges :state="i.scan" :counts="i.counts" :stale="i.stale" />
                  <button v-if="i.counts && (i.counts.critical + i.counts.high + i.counts.medium + i.counts.low + i.counts.unknown) > 0" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="open[i.imageId] = !open[i.imageId]">
                    {{ open[i.imageId] ? "Masquer" : "Détails" }}
                  </button>
                  <button class="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="scan(i.imageId, i.platform, i.ref)">
                    <FaIcon :icon="['fas', 'shield-halved']" /> Scanner
                  </button>
                </div>
              </div>
              <div v-if="open[i.imageId]" class="mt-3"><VulnerabilityTable :image-id="i.imageId" :platform="i.platform" :image-ref="i.ref" /></div>
            </li>
          </ul>
        </PanelCard>
        <p class="text-xs text-slate-500" :title="fmtDate(new Date(now).toISOString())">Actualisé {{ ago(new Date(now).toISOString()) }}.</p>
      </template>

      <VersionsTab v-else-if="tab === 'versions'" :project="project" :compose="{ dir: origin?.composeWorkingDir, files: origin?.composeConfigFiles }" />
      <MetricsTab v-else-if="tab === 'metrics'" :stack="stackLike" :project="project" />
      <LogsTab v-else-if="tab === 'logs'" :stack="stackLike" :project="project" />
      <TerminalPanel v-else-if="tab === 'terminal'" :host-id="hostId" :containers="containers" />
    </template>
    <p v-else-if="!error" class="text-slate-500">Chargement…</p>
  </div>
</template>
