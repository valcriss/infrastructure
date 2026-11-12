<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { readJson, writeJson } from "../persist";
import { ApiError, ago, api, describeError, fmtDate, formatBytes, type Application, type ScanStateName, type StackStatus } from "../api";
import AppIcon from "../components/AppIcon.vue";
import MeterBar from "../components/MeterBar.vue";
import SeverityBadges, { type Counts } from "../components/SeverityBadges.vue";
import { useSession } from "../stores/session";

const session = useSession();
const apps = ref<Application[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const noticeLink = ref("");
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
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", onDocKey);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("click", closeMenu);
  document.removeEventListener("keydown", onDocKey);
  window.removeEventListener("resize", closeMenu);
  window.removeEventListener("scroll", closeMenu, true);
});

const router = useRouter();

// Mode d'affichage (tuiles ou liste), mémorisé par navigateur.
type ViewMode = "tiles" | "list";
const VIEW_KEY = "applications.view";
const viewMode = ref<ViewMode>(readJson<unknown>(VIEW_KEY, "tiles") === "list" ? "list" : "tiles");
watch(viewMode, (v) => writeJson(VIEW_KEY, v));

// Tri de la vue liste (un clic sur un en-tête : croissant, deuxième clic : décroissant).
type SortKey = "name" | "status" | "cpu" | "mem" | "storage" | "vulns" | "deploy";
const sortKey = ref<SortKey>("name");
const sortDir = ref<1 | -1>(1);
function sortBy(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortKey.value = key;
    // Pour les métriques, on veut d'abord les plus fortes valeurs.
    sortDir.value = key === "name" || key === "status" ? 1 : -1;
  }
}
const STATUS_ORDER: Record<StackStatus, number> = { degraded: 0, unknown: 1, stopped: 2, not_deployed: 3, running: 4 };
function sortValue(a: Application, key: SortKey): string | number {
  switch (key) {
    case "name": return a.name.toLowerCase();
    case "status": return STATUS_ORDER[a.status];
    case "cpu": return a.usage?.cpuPercent ?? -1;
    case "mem": return a.usage?.memBytes ?? -1;
    case "storage": return a.storageBytes ?? -1;
    case "vulns": {
      const c = vulns(a).counts;
      return c.critical * 1e9 + c.high * 1e6 + c.medium * 1e3 + c.low;
    }
    case "deploy": return a.lastDeployAt ? new Date(a.lastDeployAt).getTime() : -1;
  }
}

// Menu d'actions (« … ») de la vue liste : un seul ouvert à la fois, positionné sous le bouton ou au-dessus s'il manque de place.
const openMenuKey = ref<string | null>(null);
const menuPos = ref<{ top?: number; bottom?: number; right: number }>({ right: 0 });
const rowKey = (a: Application) => `${a.hostId}/${a.name}`;
function closeMenu() {
  openMenuKey.value = null;
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeMenu();
}
async function toggleMenu(a: Application, e: MouseEvent) {
  const key = rowKey(a);
  if (openMenuKey.value === key) return closeMenu();
  const btn = e.currentTarget as HTMLElement;
  const r = btn.getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - r.right);
  menuPos.value = window.innerHeight - r.bottom < 190 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right };
  openMenuKey.value = key;
  await nextTick();
  document.querySelector<HTMLElement>("[data-app-menu] [role=menuitem]:not([disabled])")?.focus();
}
function onMenuKey(e: KeyboardEvent) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
}
function menuAct(a: Application, action: "start" | "stop" | "deploy") {
  closeMenu();
  void act(a, action);
}
const menuApp = computed(() => visible.value.find((a) => rowKey(a) === openMenuKey.value) ?? null);
function openApp(a: Application) {
  void router.push(a.stackId ? `/stacks/${a.stackId}` : `/hosts/${a.hostId}/projects/${encodeURIComponent(a.name)}`);
}

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

const sorted = computed(() =>
  [...visible.value].sort((x, y) => {
    const a = sortValue(x, sortKey.value);
    const b = sortValue(y, sortKey.value);
    const c = a < b ? -1 : a > b ? 1 : 0;
    return c * sortDir.value || x.name.localeCompare(y.name) || x.hostName.localeCompare(y.hostName);
  }),
);

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
  const rev = action === "deploy" ? ` (révision ${a.currentRevision}${a.deployedRevision !== null ? `, en service : ${a.deployedRevision}` : ", jamais déployée"})` : "";
  if (!window.confirm(`Voulez-vous ${label} « ${a.name} » sur ${a.hostName}${rev} ?`)) return;
  busy.value = a.stackId + action;
  notice.value = "";
  noticeLink.value = "";
  try {
    const body = action === "deploy" ? { revision: a.currentRevision, pullImages: false } : undefined;
    const r = await api<{ operationId?: string }>(`/api/v1/stacks/${a.stackId}/${action}`, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    notice.value = `Opération « ${label} » lancée pour ${a.name}.`;
    if (r?.operationId) noticeLink.value = `/stacks/${a.stackId}?tab=history&section=operations&operation=${r.operationId}`;
    window.setTimeout(() => void load(), 2500);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

/** Synthèse des vulnérabilités de toute l'application : somme par gravité et état agrégé des scans. */
function vulns(a: Application): { state: ScanStateName; counts: Counts; notes: string[] } {
  const counts: Counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let never = 0;
  let failed = 0;
  let waiting = 0;
  let stale = 0;
  for (const i of a.images) {
    if (i.counts) {
      counts.critical += i.counts.critical;
      counts.high += i.counts.high;
      counts.medium += i.counts.medium;
      counts.low += i.counts.low;
    }
    if (i.scan === "never") never++;
    else if (i.scan === "failed") failed++;
    else if (i.scan === "pending" || i.scan === "running") waiting++;
    if (i.stale) stale++;
  }
  const notes: string[] = [];
  if (never) notes.push(`${never} jamais scannée(s)`);
  if (failed) notes.push(`${failed} scan(s) en échec`);
  if (waiting) notes.push(`${waiting} scan(s) en cours ou en attente`);
  if (stale) notes.push(`${stale} scan(s) périmé(s)`);
  const unscanned = never + failed + waiting;
  // Partiel : aucun badge « Sain » trompeur, les notes expliquent ce qui manque.
  const state: ScanStateName =
    unscanned === a.images.length ? (never === a.images.length ? "never" : failed ? "failed" : "pending") : unscanned > 0 ? "vulnerable" : "clean";
  return { state, counts, notes };
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
      <RouterLink v-if="session.canOperate" to="/stacks/new" class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
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
      <div role="group" aria-label="Mode d'affichage" class="ml-auto inline-flex overflow-hidden rounded-md border border-slate-300 bg-white">
        <button type="button" title="Vue tuiles" aria-label="Vue tuiles" :aria-pressed="viewMode === 'tiles'" :class="['px-3 py-1.5', viewMode === 'tiles' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100']" @click="viewMode = 'tiles'"><FaIcon :icon="['fas', 'table-cells-large']" /></button>
        <button type="button" title="Vue liste" aria-label="Vue liste" :aria-pressed="viewMode === 'list'" :class="['border-l border-slate-300 px-3 py-1.5', viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100']" @click="viewMode = 'list'"><FaIcon :icon="['fas', 'list']" /></button>
      </div>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="notice" role="status" class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">{{ notice }} <RouterLink v-if="noticeLink" :to="noticeLink" class="font-medium underline">Suivre l'opération</RouterLink></p>
    <p v-if="loading" class="text-slate-500">Chargement…</p>
    <p v-else-if="apps.length === 0" class="text-slate-500">Aucune application. Créez-en une depuis un fichier Compose.</p>
    <p v-else-if="visible.length === 0" class="text-slate-500">Aucune application ne correspond à ces filtres.</p>

    <div v-if="viewMode === 'list' && visible.length" class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table class="w-full min-w-[640px] text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
          <tr>
            <th v-for="col in ([['name', 'Application', ''], ['status', 'État', ''], ['cpu', 'CPU', 'hidden md:table-cell'], ['mem', 'Mémoire', 'hidden md:table-cell'], ['storage', 'Stockage', 'hidden md:table-cell'], ['vulns', 'Vulnérabilités', 'hidden lg:table-cell'], ['deploy', 'Déployée', 'hidden xl:table-cell']] as const)" :key="col[0]" scope="col" :class="['px-3 py-2 font-medium', col[2]]" :aria-sort="sortKey === col[0] ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'">
              <button type="button" class="inline-flex items-center gap-1 hover:text-slate-900" @click="sortBy(col[0])">
                {{ col[1] }}
                <FaIcon v-if="sortKey === col[0]" :icon="['fas', sortDir === 1 ? 'chevron-up' : 'chevron-down']" class="text-[10px]" />
              </button>
            </th>
            <th scope="col" class="w-12 px-3 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in sorted"
            :key="rowKey(a)"
            :class="['cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50', a.containers.unhealthy ? 'bg-red-50 hover:bg-red-100' : '', a.kind === 'observed' ? 'border-l-2 border-l-slate-300' : '']"
            @click="openApp(a)"
          >
            <td class="px-3 py-2">
              <div class="flex items-center gap-3">
                <AppIcon :stack-id="a.stackId" :kind="a.kind" :icon-tag="a.iconTag" :icon-color="a.iconColor" size="sm" :title="a.kind === 'managed' ? 'Gérée par la console' : 'Observée : le fichier Compose n\'est pas connu de la console'" />
                <div class="min-w-0">
                  <RouterLink :to="a.stackId ? `/stacks/${a.stackId}` : `/hosts/${a.hostId}/projects/${encodeURIComponent(a.name)}`" class="block truncate font-medium hover:underline" @click.stop>{{ a.name }}</RouterLink>
                  <p class="flex items-center gap-1.5 text-xs text-slate-500">
                    <FaIcon :icon="['fas', 'server']" /> {{ a.hostName }}
                    <span v-if="a.hostPresence === 'offline'" class="rounded bg-red-100 px-1.5 text-red-800">hors ligne</span>
                    <span v-if="a.kind === 'observed'">· observée</span>
                  </p>
                </div>
              </div>
            </td>
            <td class="px-3 py-2">
              <span :class="['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', STATUS[a.status].cls]" :title="a.reason">
                <FaIcon :icon="['fas', STATUS[a.status].icon]" /> {{ STATUS[a.status].text }}
              </span>
              <p class="mt-0.5 text-xs text-slate-500">
                {{ a.containers.running }}/{{ a.containers.total }} conteneur(s)<template v-if="a.containers.completed"> · {{ a.containers.completed }} terminé(s)</template>
              </p>
              <p v-if="a.containers.failed || a.containers.unhealthy" class="text-xs text-red-700">
                <template v-if="a.containers.failed">{{ a.containers.failed }} en échec</template><template v-if="a.containers.failed && a.containers.unhealthy"> · </template><template v-if="a.containers.unhealthy">{{ a.containers.unhealthy }} healthcheck en échec</template>
              </p>
            </td>
            <td class="hidden px-3 py-2 md:table-cell">
              <template v-if="a.usage">
                <span class="tabular-nums">{{ a.usage.cpuPercent.toFixed(1) }} %</span>
                <div class="mt-1 h-1.5 w-20 overflow-hidden rounded bg-slate-100"><div class="h-full bg-blue-500" :style="{ width: `${Math.min(100, a.usage.cpuPercent)}%` }" /></div>
              </template>
              <span v-else class="text-slate-400">—</span>
            </td>
            <td class="hidden px-3 py-2 tabular-nums md:table-cell">{{ a.usage ? formatBytes(a.usage.memBytes) : "—" }}</td>
            <td class="hidden px-3 py-2 tabular-nums md:table-cell" title="Taille sur le disque des volumes et dossiers montés (mesurée par l'agent)">{{ a.storageBytes !== null ? formatBytes(a.storageBytes) : "—" }}</td>
            <td class="hidden px-3 py-2 lg:table-cell">
              <SeverityBadges v-if="a.images.length" :state="vulns(a).state" :counts="vulns(a).counts" />
              <span v-else class="text-xs text-slate-500">Aucune image</span>
            </td>
            <td class="hidden px-3 py-2 text-xs text-slate-500 xl:table-cell">
              <span v-if="a.lastDeployAt" :title="fmtDate(a.lastDeployAt)">{{ ago(a.lastDeployAt, now) }}</span>
              <span v-else>—</span>
              <p v-if="a.pendingDeploy && a.kind === 'managed'" class="text-amber-700">non déployée</p>
            </td>
            <td class="px-3 py-2 text-right" @click.stop>
              <button
                type="button"
                class="rounded p-2 text-slate-600 hover:bg-slate-200"
                aria-haspopup="menu"
                :aria-expanded="openMenuKey === rowKey(a)"
                :aria-label="`Actions pour ${a.name}`"
                :disabled="busy !== null"
                @click.stop="toggleMenu(a, $event)"
              >
                <FaIcon :icon="busy !== null && busy.startsWith(a.stackId ?? '\0') ? ['fas', 'arrows-rotate'] : ['fas', 'ellipsis']" :spin="busy !== null && busy.startsWith(a.stackId ?? '\0')" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="viewMode === 'list' && menuApp"
      data-app-menu
      role="menu"
      class="fixed z-50 min-w-48 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
      :style="{ top: menuPos.top !== undefined ? `${menuPos.top}px` : undefined, bottom: menuPos.bottom !== undefined ? `${menuPos.bottom}px` : undefined, right: `${menuPos.right}px` }"
      @click.stop
      @keydown="onMenuKey"
    >
      <template v-if="menuApp.kind === 'managed'">
        <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-40" :disabled="!session.canOperate || menuApp.hostPresence === 'offline' || menuApp.deployedRevision === null || menuApp.status === 'running'" @click="menuAct(menuApp, 'start')"><FaIcon :icon="['fas', 'play']" class="w-4" /> Démarrer</button>
        <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-40" :disabled="!session.canOperate || menuApp.hostPresence === 'offline' || menuApp.deployedRevision === null || menuApp.containers.running === 0" @click="menuAct(menuApp, 'stop')"><FaIcon :icon="['fas', 'stop']" class="w-4" /> Arrêter</button>
        <div class="my-1 border-t border-slate-100" />
        <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-40" :disabled="!session.canOperate || menuApp.hostPresence === 'offline'" @click="menuAct(menuApp, 'deploy')"><FaIcon :icon="['fas', 'rocket']" class="w-4" /> {{ menuApp.deployedRevision === menuApp.currentRevision ? "Redéployer" : "Déployer la révision courante" }}</button>
      </template>
      <RouterLink v-else-if="menuApp.importable" role="menuitem" :to="adoptLink(menuApp)" class="flex w-full items-center gap-2 px-3 py-2 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"><FaIcon :icon="['fas', 'download']" class="w-4" /> Prendre en charge</RouterLink>
      <p v-else class="px-3 py-2 text-xs text-slate-500">Projet de la console : aucune action.</p>
    </div>

    <div v-if="viewMode === 'tiles'" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <article
        v-for="a in visible"
        :key="`${a.hostId}/${a.name}`"
        :class="[
          'flex flex-col rounded-xl p-4 shadow-sm',
          a.containers.unhealthy ? 'bg-red-50' : 'bg-white',
          a.kind === 'managed' ? 'border' : 'border-2 border-dashed',
          a.containers.unhealthy ? 'border-red-300' : a.kind === 'managed' ? 'border-slate-200' : 'border-slate-300',
        ]"
      >
        <header class="flex items-start gap-3">
          <AppIcon :stack-id="a.stackId" :kind="a.kind" :icon-tag="a.iconTag" :icon-color="a.iconColor" :title="a.kind === 'managed' ? 'Gérée par la console' : 'Observée : le fichier Compose n\'est pas connu de la console'" />
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
          <p v-if="a.storageBytes !== null" class="flex items-center gap-1.5 text-xs text-slate-600"><FaIcon :icon="['fas', 'hard-drive']" class="text-slate-400" /> Stockage : <span class="font-medium tabular-nums">{{ formatBytes(a.storageBytes) }}</span></p>
        </div>

        <div class="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs">
          <template v-if="a.images.length">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 text-slate-600"><FaIcon :icon="['fas', 'shield-halved']" class="text-slate-400" /> Vulnérabilités · {{ a.images.length }} image(s)</span>
              <SeverityBadges :state="vulns(a).state" :counts="vulns(a).counts" />
            </div>
            <p v-if="vulns(a).notes.length" class="text-slate-500">{{ vulns(a).notes.join(" · ") }}</p>
          </template>
          <p v-else class="flex items-center gap-1.5 text-slate-500"><FaIcon :icon="['fas', 'layer-group']" class="text-slate-400" /> Aucune image observée</p>
        </div>

        <footer class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            <span v-if="a.pendingDeploy && a.kind === 'managed'" class="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" title="La configuration a changé depuis le dernier déploiement"><FaIcon :icon="['fas', 'code-branch']" /> non déployée</span>
            <span v-if="a.updatesAvailable" class="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-blue-800"><FaIcon :icon="['fas', 'arrows-rotate']" /> {{ a.updatesAvailable }} mise(s) à jour</span>
            <span v-if="a.lastDeployAt" class="inline-flex items-center gap-1 text-slate-500" :title="fmtDate(a.lastDeployAt)"><FaIcon :icon="['fas', 'clock']" /> déployée {{ ago(a.lastDeployAt, now).replace("il y a ", "il y a ") }}</span>
          </div>
          <div class="flex items-center gap-1">
            <template v-if="a.kind === 'managed'">
              <button class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" title="Démarrer" aria-label="Démarrer" :disabled="busy !== null || !session.canOperate || a.hostPresence === 'offline' || a.deployedRevision === null" @click="act(a, 'start')"><FaIcon :icon="['fas', 'play']" /></button>
              <button class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" title="Arrêter" aria-label="Arrêter" :disabled="busy !== null || !session.canOperate || a.hostPresence === 'offline' || a.deployedRevision === null" @click="act(a, 'stop')"><FaIcon :icon="['fas', 'stop']" /></button>
              <button class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" :title="a.deployedRevision === a.currentRevision ? 'Redéployer la révision active' : 'Déployer la révision courante'" aria-label="Déployer" :disabled="busy !== null || !session.canOperate || a.hostPresence === 'offline'" @click="act(a, 'deploy')"><FaIcon :icon="['fas', 'rocket']" /></button>
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
