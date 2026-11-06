<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, ago, api, describeError, fmtDate, formatBytes, type Application, type StackStatus } from "../api";
import MeterBar from "../components/MeterBar.vue";
import SeverityBadges from "../components/SeverityBadges.vue";

const apps = ref<Application[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const busy = ref<string | null>(null);
const now = ref(Date.now());
let timer: number | undefined;

const search = ref("");
const hostFilter = ref("");
const statusFilter = ref<"" | StackStatus>("");
const kindFilter = ref<"" | "managed" | "observed">("");

async function load() {
  try {
    apps.value = (await api<{ applications: Application[] }>("/api/v1/applications")).applications;
    now.value = Date.now();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const hosts = computed(() => [...new Map(apps.value.map((a) => [a.hostId, a.hostName])).entries()]);
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return apps.value.filter(
    (a) =>
      (!q || a.name.toLowerCase().includes(q) || a.services.some((s) => s.toLowerCase().includes(q))) &&
      (!hostFilter.value || a.hostId === hostFilter.value) &&
      (!statusFilter.value || a.status === statusFilter.value) &&
      (!kindFilter.value || a.kind === kindFilter.value),
  );
});

const STATUS: Record<StackStatus, { text: string; cls: string; dot: string; icon: string }> = {
  running: { text: "En marche", cls: "bg-green-100 text-green-800", dot: "bg-green-500", icon: "circle-check" },
  degraded: { text: "Dégradée", cls: "bg-red-100 text-red-800", dot: "bg-red-500", icon: "triangle-exclamation" },
  stopped: { text: "Arrêtée", cls: "bg-slate-200 text-slate-700", dot: "bg-slate-400", icon: "stop" },
  unknown: { text: "Inconnue", cls: "bg-amber-100 text-amber-800", dot: "bg-amber-500", icon: "circle-info" },
  not_deployed: { text: "Jamais déployée", cls: "bg-blue-100 text-blue-800", dot: "bg-blue-400", icon: "download" },
};

async function act(a: Application, action: "start" | "stop" | "deploy") {
  if (!a.stackId) return;
  const label = { start: "démarrer", stop: "arrêter", deploy: "déployer" }[action];
  if (!window.confirm(`Voulez-vous ${label} « ${a.name} » sur ${a.hostName} ?`)) return;
  busy.value = a.stackId + action;
  notice.value = "";
  try {
    const body = action === "deploy" ? { revision: a.currentRevision, pullImages: false } : undefined;
    await api(`/api/v1/stacks/${a.stackId}/${action}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
    notice.value = `Opération « ${label} » lancée pour ${a.name} : suivez-la dans l'onglet Opérations de l'application.`;
    window.setTimeout(() => void load(), 2500);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

const adoptLink = (a: Application) => ({ path: "/stacks/new", query: { adopt: "1", host: a.hostId, name: a.name } });
const totals = computed(() => ({ managed: apps.value.filter((a) => a.kind === "managed").length, observed: apps.value.filter((a) => a.kind === "observed").length }));
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Applications</h1>
        <p class="text-sm text-slate-500">{{ totals.managed }} gérée(s) par la console · {{ totals.observed }} observée(s) (en marche sans leur fichier Compose)</p>
      </div>
      <RouterLink to="/stacks/new" class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
        <FaIcon :icon="['fas', 'plus']" /> Nouvelle application
      </RouterLink>
    </div>

    <div class="flex flex-wrap items-center gap-3 text-sm">
      <label class="relative">
        <span class="sr-only">Rechercher</span>
        <FaIcon :icon="['fas', 'magnifying-glass']" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input v-model="search" type="search" placeholder="Rechercher une application ou un service" class="w-72 rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-3" />
      </label>
      <select v-model="kindFilter" aria-label="Type" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <option value="">Toutes</option>
        <option value="managed">Gérées</option>
        <option value="observed">Observées</option>
      </select>
      <select v-model="statusFilter" aria-label="État" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <option value="">Tous les états</option>
        <option v-for="(s, k) in STATUS" :key="k" :value="k">{{ s.text }}</option>
      </select>
      <select v-model="hostFilter" aria-label="Hôte" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <option value="">Tous les hôtes</option>
        <option v-for="[id, name] in hosts" :key="id" :value="id">{{ name }}</option>
      </select>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="notice" role="status" class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">{{ notice }}</p>
    <p v-if="loading" class="text-slate-500">Chargement…</p>
    <p v-else-if="apps.length === 0" class="text-slate-500">Aucune application. Créez-en une depuis un fichier Compose.</p>
    <p v-else-if="visible.length === 0" class="text-slate-500">Aucune application ne correspond à ces filtres.</p>

    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <article
        v-for="a in visible"
        :key="`${a.hostId}/${a.name}`"
        :class="['flex flex-col rounded-xl bg-white p-4 shadow-sm', a.kind === 'managed' ? 'border border-slate-200' : 'border-2 border-dashed border-slate-300']"
      >
        <header class="flex items-start gap-3">
          <span :class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg', a.kind === 'managed' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500']" :title="a.kind === 'managed' ? 'Gérée par la console' : 'Observée : le fichier Compose n\'est pas connu de la console'">
            <FaIcon :icon="['fas', a.kind === 'managed' ? 'boxes-stacked' : 'eye']" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate font-semibold">
              <RouterLink v-if="a.stackId" :to="`/stacks/${a.stackId}`" class="hover:underline">{{ a.name }}</RouterLink>
              <RouterLink v-else :to="`/hosts/${a.hostId}/projects/${encodeURIComponent(a.name)}`" class="hover:underline">{{ a.name }}</RouterLink>
            </h2>
            <p class="flex items-center gap-1.5 text-xs text-slate-500">
              <FaIcon :icon="['fas', 'server']" /> {{ a.hostName }}
              <span v-if="a.hostPresence === 'offline'" class="rounded bg-red-100 px-1.5 text-red-800">hors ligne</span>
            </p>
          </div>
          <span :class="['inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', STATUS[a.status].cls]" :title="a.reason">
            <FaIcon :icon="['fas', STATUS[a.status].icon]" /> {{ STATUS[a.status].text }}
          </span>
        </header>

        <p class="mt-2 text-xs text-slate-500">
          <span :class="a.kind === 'managed' ? 'text-blue-700' : 'text-slate-600'">{{ a.kind === "managed" ? "Gérée par la console" : "Observée, non gérée" }}</span>
          · {{ a.containers.running }}/{{ a.containers.total }} conteneur(s) en marche
          <template v-if="a.containers.completed"> · {{ a.containers.completed }} terminé(s)</template>
        </p>
        <p v-if="a.containers.failed || a.containers.unhealthy" class="mt-1 flex items-center gap-1 text-xs text-red-700">
          <FaIcon :icon="['fas', 'triangle-exclamation']" />
          <template v-if="a.containers.failed">{{ a.containers.failed }} en échec</template>
          <template v-if="a.containers.failed && a.containers.unhealthy"> · </template>
          <template v-if="a.containers.unhealthy">{{ a.containers.unhealthy }} healthcheck en échec</template>
        </p>

        <div v-if="a.usage" class="mt-3 space-y-2">
          <MeterBar label="CPU" icon="microchip" :percent="Math.min(100, a.usage.cpuPercent)" :detail="`${a.usage.cpuPercent.toFixed(1)} % d'un cœur`" />
          <p class="flex items-center gap-1.5 text-xs text-slate-600"><FaIcon :icon="['fas', 'memory']" class="text-slate-400" /> Mémoire : <span class="font-medium tabular-nums">{{ formatBytes(a.usage.memBytes) }}</span></p>
        </div>

        <ul v-if="a.images.length" class="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
          <li v-for="i in a.images" :key="i.ref" class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span class="flex min-w-0 items-center gap-1.5 text-slate-600"><FaIcon :icon="['fas', 'layer-group']" class="shrink-0 text-slate-400" /><span class="truncate" :title="i.ref">{{ i.ref }}</span></span>
            <SeverityBadges :state="i.scan" :counts="i.counts" :stale="i.stale" />
          </li>
        </ul>

        <footer class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            <span v-if="a.pendingDeploy && a.kind === 'managed'" class="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" title="La configuration a changé depuis le dernier déploiement"><FaIcon :icon="['fas', 'code-branch']" /> non déployée</span>
            <span v-if="a.updatesAvailable" class="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-blue-800"><FaIcon :icon="['fas', 'arrows-rotate']" /> {{ a.updatesAvailable }} mise(s) à jour</span>
            <span v-if="a.lastDeployAt" class="inline-flex items-center gap-1 text-slate-500" :title="fmtDate(a.lastDeployAt)"><FaIcon :icon="['fas', 'clock']" /> déployée {{ ago(a.lastDeployAt, now).replace("il y a ", "il y a ") }}</span>
          </div>
          <div class="flex items-center gap-1">
            <template v-if="a.kind === 'managed'">
              <button class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" title="Démarrer" aria-label="Démarrer" :disabled="busy !== null || a.hostPresence === 'offline' || a.deployedRevision === null" @click="act(a, 'start')"><FaIcon :icon="['fas', 'play']" /></button>
              <button class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" title="Arrêter" aria-label="Arrêter" :disabled="busy !== null || a.hostPresence === 'offline' || a.deployedRevision === null" @click="act(a, 'stop')"><FaIcon :icon="['fas', 'stop']" /></button>
              <button class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" title="Déployer la révision courante" aria-label="Déployer" :disabled="busy !== null || a.hostPresence === 'offline'" @click="act(a, 'deploy')"><FaIcon :icon="['fas', 'rocket']" /></button>
            </template>
            <RouterLink v-else-if="a.importable" :to="adoptLink(a)" class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-100">
              <FaIcon :icon="['fas', 'download']" /> Prendre en charge
            </RouterLink>
            <span v-else class="text-xs text-slate-500">projet de la console</span>
          </div>
        </footer>
      </article>
    </div>
  </div>
</template>
