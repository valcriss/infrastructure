<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, ago, api, describeError, fmtDate, formatBytes, type Host, type HostDetail, type ObservedProject, type OverviewResult } from "../api";
import { TONE } from "../charts/palette";
import DiskBar from "../components/DiskBar.vue";
import MeterBar from "../components/MeterBar.vue";
import PageTitle from "../components/PageTitle.vue";
import PruneDialog from "../components/PruneDialog.vue";

const hosts = ref<Host[]>([]);
const overview = ref<OverviewResult | null>(null);
const loading = ref(true);
const error = ref("");
const selected = ref<HostDetail | null>(null);
const newToken = ref<{ token: string; expiresAt: string } | null>(null);
const projects = ref<ObservedProject[]>([]);
const pruning = ref<Host | null>(null);
const refreshing = ref<string | null>(null);
const now = ref(Date.now());
let timer: number | undefined;

async function load() {
  try {
    const [h, o] = await Promise.all([api<{ hosts: Host[] }>("/api/v1/hosts"), api<OverviewResult>("/api/v1/dashboard/overview?range=1h").catch(() => null)]);
    hosts.value = h.hosts;
    if (o) overview.value = o;
    if (selected.value) await select(selected.value.id);
    now.value = Date.now();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  } finally {
    loading.value = false;
  }
}

async function select(id: string) {
  selected.value = await api<HostDetail>(`/api/v1/hosts/${id}`);
  projects.value = (await api<{ projects: ObservedProject[] }>(`/api/v1/hosts/${id}/projects`)).projects;
}

async function createToken() {
  newToken.value = await api("/api/v1/agents/enrollment-tokens", { method: "POST", body: "{}" });
}

async function revoke(host: Host) {
  if (!confirm(`Révoquer l'hôte « ${host.name} » ? Son agent sera déconnecté.`)) return;
  await api(`/api/v1/hosts/${host.id}`, { method: "DELETE" });
  if (selected.value?.id === host.id) selected.value = null;
  await load();
}

async function refreshDisk(h: Host) {
  refreshing.value = h.id;
  error.value = "";
  try {
    await api(`/api/v1/hosts/${h.id}/disk-usage/refresh`, { method: "POST" });
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    refreshing.value = null;
  }
}

const resources = (id: string) => overview.value?.hosts.find((x) => x.hostId === id);
const pct = (used: number | null | undefined, total: number | null | undefined): number | null => (used === null || used === undefined || !total ? null : (used / total) * 100);

const DISK_ROWS = [
  { key: "images", label: "Images", icon: "layer-group", color: TONE.accent },
  { key: "containers", label: "Conteneurs", icon: "cube", color: TONE.ok },
  { key: "volumes", label: "Volumes", icon: "database", color: TONE.warn },
  { key: "buildCache", label: "Cache de build", icon: "box", color: TONE.violet },
] as const;

const segments = (h: Host) => DISK_ROWS.map((r) => ({ label: r.label, value: h.diskUsage?.summary[r.key].sizeBytes ?? 0, color: r.color }));
const totalSize = (h: Host): number => DISK_ROWS.reduce((s, r) => s + (h.diskUsage?.summary[r.key].sizeBytes ?? 0), 0);
const totalReclaimable = (h: Host): number => DISK_ROWS.reduce((s, r) => s + (h.diskUsage?.summary[r.key].reclaimableBytes ?? 0), 0);

const byProject = computed(() => {
  const groups = new Map<string, HostDetail["containers"]>();
  for (const c of selected.value?.containers ?? []) {
    const key = c.composeProject ?? "(hors Compose)";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
});

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <PageTitle title="Hôtes" icon="server" subtitle="Machines Docker gérées par un agent : ressources, espace disque Docker et nettoyage" />
      <button class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" @click="createToken">
        <FaIcon :icon="['fas', 'plus']" /> Enrôler un hôte
      </button>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>

    <section v-if="newToken" class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p class="font-medium">Jeton d'enrôlement (affiché une seule fois, valable jusqu'à {{ fmtDate(newToken.expiresAt) }})</p>
      <code class="mt-2 block break-all rounded bg-white px-2 py-1 font-mono text-slate-900">{{ newToken.token }}</code>
      <p class="mt-2">Lancez le Compose de l'agent sur l'hôte cible avec <code>ENROLLMENT_TOKEN</code> et <code>CONSOLE_URL</code> renseignés.</p>
      <button class="mt-2 underline" @click="newToken = null">Fermer</button>
    </section>

    <p v-if="loading" class="text-slate-500">Chargement…</p>
    <p v-else-if="hosts.length === 0" class="text-slate-500">Aucun hôte. L'agent local s'enrôle automatiquement au démarrage.</p>

    <div class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      <article v-for="h in hosts" :key="h.id" :class="['flex flex-col rounded-xl border bg-white p-5 shadow-sm', selected?.id === h.id ? 'border-blue-400' : 'border-slate-200']">
        <header class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="flex items-center gap-2 text-lg font-semibold">
              <span :class="['inline-block h-2.5 w-2.5 rounded-full', h.presence === 'online' ? 'bg-green-500' : 'bg-slate-400']" aria-hidden="true"></span>
              {{ h.name }}
            </h2>
            <p class="mt-0.5 text-xs text-slate-500">
              {{ h.presence === "online" ? "En ligne" : "Hors ligne (état inconnu)" }} · vu <span :title="fmtDate(h.lastSeenAt)">{{ ago(h.lastSeenAt, now) }}</span>
            </p>
            <p class="text-xs text-slate-500">Docker {{ h.dockerVersion ?? "?" }} · agent {{ h.agentVersion ?? "?" }}<template v-if="resources(h.id)?.cpus"> · {{ resources(h.id)?.cpus }} cœur(s)</template> · {{ h.containerCount ?? "?" }} conteneur(s)</p>
          </div>
        </header>

        <section class="mt-4 space-y-2" aria-label="Ressources de la machine">
          <template v-if="resources(h.id)?.latest">
            <MeterBar label="CPU" icon="microchip" :percent="resources(h.id)?.latest?.cpuPercent ?? null" />
            <MeterBar label="Mémoire" icon="memory" :percent="pct(resources(h.id)?.latest?.memUsed, resources(h.id)?.latest?.memTotal)" :detail="resources(h.id)?.latest?.memTotal ? `${formatBytes(resources(h.id)?.latest?.memUsed ?? 0)} / ${formatBytes(resources(h.id)?.latest?.memTotal ?? 0)}` : undefined" />
            <MeterBar label="Disque (partition de l'espace de travail)" icon="hard-drive" :percent="pct(resources(h.id)?.latest?.diskUsed, resources(h.id)?.latest?.diskTotal)" :detail="resources(h.id)?.latest?.diskTotal ? `${formatBytes(resources(h.id)?.latest?.diskUsed ?? 0)} / ${formatBytes(resources(h.id)?.latest?.diskTotal ?? 0)}` : undefined" />
          </template>
          <p v-else class="text-xs text-slate-500">Pas de relevé de la machine (agent à jour et en ligne requis).</p>
        </section>

        <section class="mt-5 border-t border-slate-100 pt-4" aria-label="Espace disque Docker">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="flex items-center gap-2 text-sm font-semibold"><FaIcon :icon="['fas', 'database']" class="text-slate-400" /> Espace Docker</h3>
            <button class="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="Actualiser le relevé" aria-label="Actualiser le relevé" :disabled="h.presence !== 'online' || refreshing === h.id" @click="refreshDisk(h)">
              <FaIcon :icon="['fas', 'arrows-rotate']" :spin="refreshing === h.id" />
            </button>
          </div>
          <template v-if="h.diskUsage">
            <DiskBar :segments="segments(h)" />
            <table class="mt-3 w-full text-xs">
              <thead class="text-left text-slate-500"><tr><th class="pb-1 font-normal">Type</th><th class="pb-1 text-right font-normal">Nombre</th><th class="pb-1 text-right font-normal">Taille</th><th class="pb-1 text-right font-normal">Récupérable</th></tr></thead>
              <tbody>
                <tr v-for="r in DISK_ROWS" :key="r.key" class="border-t border-slate-100">
                  <td class="py-1"><span class="mr-2 inline-block h-2 w-2 rounded-full" :style="{ backgroundColor: r.color }"></span>{{ r.label }}</td>
                  <td class="py-1 text-right tabular-nums">{{ h.diskUsage.summary[r.key].count }}</td>
                  <td class="py-1 text-right tabular-nums">{{ formatBytes(h.diskUsage.summary[r.key].sizeBytes) }}</td>
                  <td class="py-1 text-right tabular-nums text-slate-500">{{ formatBytes(h.diskUsage.summary[r.key].reclaimableBytes) }}</td>
                </tr>
                <tr class="border-t border-slate-200 font-medium">
                  <td class="py-1">Total</td><td></td>
                  <td class="py-1 text-right tabular-nums">{{ formatBytes(totalSize(h)) }}</td>
                  <td class="py-1 text-right tabular-nums">{{ formatBytes(totalReclaimable(h)) }}</td>
                </tr>
              </tbody>
            </table>
            <p class="mt-1 text-[11px] text-slate-400" :title="fmtDate(h.diskUsage.observedAt)">Relevé {{ ago(h.diskUsage.observedAt, now) }} · comme « docker system df »</p>
          </template>
          <p v-else class="text-xs text-slate-500">Pas encore de relevé : il arrive dans les minutes qui suivent la connexion d'un agent à jour.</p>
        </section>

        <footer class="mt-auto flex flex-wrap items-center gap-2 pt-5 text-sm">
          <button class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-40" :disabled="h.presence !== 'online' || !h.diskUsage" :title="h.presence !== 'online' ? 'Hôte hors ligne' : !h.diskUsage ? 'Agent à jour requis' : ''" @click="pruning = h">
            <FaIcon :icon="['fas', 'broom']" /> Nettoyer…
          </button>
          <button class="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100" @click="select(h.id)">Conteneurs</button>
          <button class="ml-auto rounded-md border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50" @click="revoke(h)">Révoquer</button>
        </footer>
      </article>
    </div>

    <section v-if="selected && projects.length" class="space-y-3">
      <h2 class="text-lg font-semibold">Projets Compose observés sur {{ selected.name }}</h2>
      <p class="text-sm text-slate-600">Ces projets sont seulement observés : la console n'y touche pas tant que vous ne les avez pas importés avec leur fichier Compose.</p>
      <ul class="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white text-sm">
        <li v-for="p in projects" :key="p.name" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div>
            <span class="font-medium">{{ p.name }}</span>
            <span class="ml-2 text-xs text-slate-500">{{ p.running }}/{{ p.total }} en marche · {{ p.services.map((s) => s.service).join(", ") }}</span>
          </div>
          <RouterLink v-if="p.managedStackId" :to="`/stacks/${p.managedStackId}`" class="underline">Gérée par une stack</RouterLink>
          <RouterLink v-else-if="p.importable" :to="{ path: '/stacks/new', query: { adopt: '1', host: selected.id, name: p.name } }" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100">Importer</RouterLink>
          <span v-else class="text-xs text-slate-500">projet de la console (non importable)</span>
        </li>
      </ul>
    </section>

    <section v-if="selected" class="space-y-4">
      <h2 class="text-lg font-semibold">Conteneurs de {{ selected.name }}</h2>
      <p v-if="selected.presence !== 'online'" class="text-sm text-amber-700">Hôte hors ligne : ces états sont ceux de la dernière observation ({{ fmtDate(selected.inventoryObservedAt) }}).</p>
      <div v-for="[project, list] in byProject" :key="project" class="rounded-xl border border-slate-200 bg-white">
        <h3 class="border-b border-slate-200 px-4 py-2 text-sm font-medium">{{ project }}</h3>
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-slate-500">
            <tr><th class="px-4 py-1">Nom</th><th class="px-4 py-1">Image</th><th class="px-4 py-1">État</th><th class="px-4 py-1">Healthcheck</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in list" :key="c.id" class="border-t border-slate-100">
              <td class="px-4 py-1.5">{{ c.names[0] ?? c.id.slice(0, 12) }}</td>
              <td class="px-4 py-1.5 font-mono text-xs">{{ c.image }}</td>
              <td class="px-4 py-1.5">{{ c.state }}</td>
              <td class="px-4 py-1.5 text-xs">{{ c.health && c.health !== "none" ? c.health : "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <PruneDialog v-if="pruning" :host="pruning" @close="pruning = null" @done="load" />
  </div>
</template>
