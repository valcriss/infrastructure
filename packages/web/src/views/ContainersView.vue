<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, ago, api, describeError, fmtDate, formatBytes, type ContainerRow } from "../api";
import ContainerDrawer, { type DrawerTab } from "../components/ContainerDrawer.vue";
import MeterBar from "../components/MeterBar.vue";
import { readJson, writeJson } from "../persist";
import { useSession } from "../stores/session";

const session = useSession();
const containers = ref<ContainerRow[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const busy = ref<string | null>(null);
const now = ref(Date.now());
let timer: number | undefined;

const search = ref("");
const hostFilter = ref("");
const stateFilter = ref("");
const appFilter = ref("");
const problemsOnly = ref(false);

async function load() {
  try {
    containers.value = (await api<{ containers: ContainerRow[] }>("/api/v1/containers")).containers;
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

// Mode d'affichage (liste par défaut : il y a bien plus de conteneurs que d'applications), mémorisé par navigateur.
type ViewMode = "tiles" | "list";
const VIEW_KEY = "containers.view";
const viewMode = ref<ViewMode>(readJson<unknown>(VIEW_KEY, "list") === "tiles" ? "tiles" : "list");
watch(viewMode, (v) => writeJson(VIEW_KEY, v));

const STATE: Record<string, { text: string; cls: string; icon: string }> = {
  running: { text: "En marche", cls: "bg-green-100 text-green-800", icon: "circle-check" },
  exited: { text: "Arrêté", cls: "bg-slate-200 text-slate-700", icon: "stop" },
  restarting: { text: "Redémarre", cls: "bg-red-100 text-red-800", icon: "arrows-rotate" },
  paused: { text: "En pause", cls: "bg-amber-100 text-amber-800", icon: "circle-info" },
  created: { text: "Créé", cls: "bg-blue-100 text-blue-800", icon: "download" },
  dead: { text: "Mort", cls: "bg-red-100 text-red-800", icon: "triangle-exclamation" },
};
const stateOf = (c: ContainerRow) => {
  // Un conteneur terminé normalement (code 0) n'est pas un échec.
  if (c.state === "exited" && c.exitCode === 0) return { text: "Terminé", cls: "bg-slate-100 text-slate-600", icon: "circle-check" };
  if (c.state === "exited" && c.exitCode) return { text: `Arrêté (code ${c.exitCode})`, cls: "bg-red-100 text-red-800", icon: "triangle-exclamation" };
  return STATE[c.state] ?? { text: c.state || "Inconnu", cls: "bg-amber-100 text-amber-800", icon: "circle-info" };
};
const HEALTH: Record<string, { text: string; cls: string }> = {
  unhealthy: { text: "Healthcheck en échec", cls: "bg-red-100 text-red-800" },
  starting: { text: "Healthcheck en cours", cls: "bg-amber-100 text-amber-800" },
  healthy: { text: "Sain", cls: "bg-green-100 text-green-800" },
};
/** Conteneur à surveiller : en échec, en boucle de redémarrage ou dont le healthcheck échoue. */
const isProblem = (c: ContainerRow): boolean =>
  c.state === "restarting" || c.state === "dead" || (c.state === "exited" && !!c.exitCode) || (c.state === "running" && c.health === "unhealthy");

const hosts = computed(() => [...new Map(containers.value.map((c) => [c.hostId, c.hostName])).entries()]);
const apps = computed(() => [...new Set(containers.value.map((c) => c.project).filter((p): p is string => !!p))].sort());
const states = computed(() => [...new Set(containers.value.map((c) => c.state))].sort());
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return containers.value.filter(
    (c) =>
      (!q || [c.name, c.image, c.service, c.project].some((v) => v?.toLowerCase().includes(q))) &&
      (!hostFilter.value || c.hostId === hostFilter.value) &&
      (!stateFilter.value || c.state === stateFilter.value) &&
      (!appFilter.value || (appFilter.value === "__none__" ? c.project === null : c.project === appFilter.value)) &&
      (!problemsOnly.value || isProblem(c)),
  );
});
const problemCount = computed(() => containers.value.filter(isProblem).length);

// Tri (un clic sur un en-tête : croissant, deuxième clic : décroissant).
type SortKey = "name" | "state" | "cpu" | "mem" | "started";
const sortKey = ref<SortKey>("name");
const sortDir = ref<1 | -1>(1);
function sortBy(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortKey.value = key;
    sortDir.value = key === "name" || key === "state" ? 1 : -1;
  }
}
const STATE_ORDER: Record<string, number> = { restarting: 0, dead: 1, paused: 2, created: 3, exited: 4, running: 5 };
function sortValue(c: ContainerRow, key: SortKey): string | number {
  switch (key) {
    case "name": return c.name.toLowerCase();
    // Les problèmes d'abord.
    case "state": return isProblem(c) ? -1 : (STATE_ORDER[c.state] ?? 6);
    case "cpu": return c.usage?.cpuPercent ?? -1;
    case "mem": return c.usage?.memBytes ?? -1;
    case "started": return c.startedAt ? Date.parse(c.startedAt) || -1 : -1;
  }
}
const sorted = computed(() =>
  [...visible.value].sort((x, y) => {
    const a = sortValue(x, sortKey.value);
    const b = sortValue(y, sortKey.value);
    const c = a < b ? -1 : a > b ? 1 : 0;
    return c * sortDir.value || x.name.localeCompare(y.name) || x.hostName.localeCompare(y.hostName);
  }),
);

const rowKey = (c: ContainerRow) => `${c.hostId}/${c.id}`;
const appLink = (c: ContainerRow) => (c.stackId ? `/stacks/${c.stackId}` : c.project ? `/hosts/${c.hostId}/projects/${encodeURIComponent(c.project)}` : null);
const portsText = (c: ContainerRow): string => {
  const seen = new Set<string>();
  for (const p of c.ports) seen.add(p.publicPort ? `${p.publicPort}→${p.privatePort}` : String(p.privatePort));
  const list = [...seen];
  return list.length > 4 ? `${list.slice(0, 4).join(", ")}…` : list.join(", ");
};
const canConsole = (c: ContainerRow): boolean => session.info?.terminalAllowed === true && !c.protected && c.state === "running" && c.hostPresence === "online";

// Tiroir (logs, console, stats) : le conteneur est retrouvé par clé à chaque rafraîchissement pour rester à jour.
const drawer = ref<{ key: string; tab: DrawerTab } | null>(null);
const drawerContainer = computed(() => (drawer.value ? (containers.value.find((c) => rowKey(c) === drawer.value?.key) ?? null) : null));
function openDrawer(c: ContainerRow, tab: DrawerTab) {
  closeMenu();
  drawer.value = { key: rowKey(c), tab };
}

// Actions de cycle de vie : hors Compose, avec confirmation.
type Action = "start" | "stop" | "restart";
const LABEL: Record<Action, { verb: string; done: string }> = { start: { verb: "démarrer", done: "démarré" }, stop: { verb: "arrêter", done: "arrêté" }, restart: { verb: "redémarrer", done: "redémarré" } };
const canAct = (c: ContainerRow): boolean => session.canOperate && !c.protected && c.hostPresence === "online";
async function act(c: ContainerRow, action: Action) {
  const warn = c.appKind === "managed" ? `\n\nCe conteneur fait partie de l'application « ${c.project} » : l'action sort du cycle Compose, et un redéploiement remettra le conteneur dans l'état défini.` : "";
  if (!window.confirm(`Voulez-vous ${LABEL[action].verb} le conteneur « ${c.name} » sur ${c.hostName} ?${warn}`)) return;
  busy.value = rowKey(c);
  notice.value = "";
  error.value = "";
  try {
    await api(`/api/v1/hosts/${c.hostId}/containers/${c.id}/actions/${action}`, { method: "POST" });
    notice.value = `Conteneur « ${c.name} » ${LABEL[action].done}.`;
    window.setTimeout(() => void load(), 1500);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

// Menu « … » : un seul ouvert à la fois, sous le bouton ou au-dessus s'il manque de place.
const openMenuKey = ref<string | null>(null);
const menuPos = ref<{ top?: number; bottom?: number; right: number }>({ right: 0 });
function closeMenu() {
  openMenuKey.value = null;
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !drawer.value) closeMenu();
}
async function toggleMenu(c: ContainerRow, e: MouseEvent) {
  const key = rowKey(c);
  if (openMenuKey.value === key) return closeMenu();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - r.right);
  menuPos.value = window.innerHeight - r.bottom < 220 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right };
  openMenuKey.value = key;
  await nextTick();
  document.querySelector<HTMLElement>("[data-container-menu] [role=menuitem]:not([disabled])")?.focus();
}
function onMenuKey(e: KeyboardEvent) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
}
const menuContainer = computed(() => containers.value.find((c) => rowKey(c) === openMenuKey.value) ?? null);
function menuAct(c: ContainerRow, action: Action) {
  closeMenu();
  void act(c, action);
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-2xl font-semibold">Conteneurs</h1>
      <p class="text-sm text-slate-500">
        {{ containers.length }} conteneur(s) sur {{ hosts.length }} hôte(s), y compris ceux qui ne font partie d'aucune application
        <template v-if="problemCount"> · <span class="text-red-700">{{ problemCount }} à surveiller</span></template>
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-3 text-sm">
      <label class="relative">
        <span class="sr-only">Rechercher</span>
        <FaIcon :icon="['fas', 'magnifying-glass']" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input v-model="search" type="search" placeholder="Rechercher un conteneur, une image, un service" class="w-80 rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-3" />
      </label>
      <select v-model="stateFilter" aria-label="État" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <option value="">Tous les états</option>
        <option v-for="s in states" :key="s" :value="s">{{ STATE[s]?.text ?? s }}</option>
      </select>
      <select v-model="hostFilter" aria-label="Hôte" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <option value="">Tous les hôtes</option>
        <option v-for="[id, name] in hosts" :key="id" :value="id">{{ name }}</option>
      </select>
      <select v-model="appFilter" aria-label="Application" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <option value="">Toutes les applications</option>
        <option value="__none__">Hors Compose</option>
        <option v-for="a in apps" :key="a" :value="a">{{ a }}</option>
      </select>
      <label class="flex items-center gap-1.5"><input v-model="problemsOnly" type="checkbox" /> Avec problème seulement</label>
      <div role="group" aria-label="Mode d'affichage" class="ml-auto inline-flex overflow-hidden rounded-md border border-slate-300 bg-white">
        <button type="button" title="Vue tuiles" aria-label="Vue tuiles" :aria-pressed="viewMode === 'tiles'" :class="['px-3 py-1.5', viewMode === 'tiles' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100']" @click="viewMode = 'tiles'"><FaIcon :icon="['fas', 'table-cells-large']" /></button>
        <button type="button" title="Vue liste" aria-label="Vue liste" :aria-pressed="viewMode === 'list'" :class="['border-l border-slate-300 px-3 py-1.5', viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100']" @click="viewMode = 'list'"><FaIcon :icon="['fas', 'list']" /></button>
      </div>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="notice" role="status" class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">{{ notice }}</p>
    <p v-if="loading" class="text-slate-500">Chargement…</p>
    <p v-else-if="containers.length === 0" class="text-slate-500">Aucun conteneur : aucun hôte n'a encore remonté son inventaire.</p>
    <p v-else-if="visible.length === 0" class="text-slate-500">Aucun conteneur ne correspond à ces filtres.</p>

    <!-- Vue liste -->
    <div v-if="viewMode === 'list' && visible.length" class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table class="w-full min-w-[720px] text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
          <tr>
            <th v-for="col in ([['name', 'Conteneur', ''], ['state', 'État', ''], ['cpu', 'CPU', 'hidden md:table-cell'], ['mem', 'Mémoire', 'hidden md:table-cell'], ['started', 'Démarré', 'hidden xl:table-cell']] as const)" :key="col[0]" scope="col" :class="['px-3 py-2 font-medium', col[2]]" :aria-sort="sortKey === col[0] ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'">
              <button type="button" class="inline-flex items-center gap-1 hover:text-slate-900" @click="sortBy(col[0])">
                {{ col[1] }}
                <FaIcon v-if="sortKey === col[0]" :icon="['fas', sortDir === 1 ? 'chevron-up' : 'chevron-down']" class="text-[10px]" />
              </button>
            </th>
            <th scope="col" class="hidden px-3 py-2 font-medium lg:table-cell">Ports</th>
            <th scope="col" class="px-3 py-2 text-right"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in sorted" :key="rowKey(c)" :class="['border-b border-slate-100 last:border-0 hover:bg-slate-50', isProblem(c) ? 'bg-red-50 hover:bg-red-100' : '']">
            <td class="px-3 py-2">
              <button type="button" class="block max-w-xs truncate text-left font-medium hover:underline" :title="`Ouvrir les logs de ${c.name}`" @click="openDrawer(c, 'logs')">{{ c.name }}</button>
              <p class="truncate text-xs text-slate-500" :title="c.image">{{ c.image }}</p>
              <p class="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
                <FaIcon :icon="['fas', 'server']" /> {{ c.hostName }}
                <span v-if="c.hostPresence === 'offline'" class="rounded bg-red-100 px-1.5 text-red-800">hors ligne</span>
                <span>·</span>
                <RouterLink v-if="appLink(c)" :to="appLink(c) as string" class="hover:underline">{{ c.project }}<template v-if="c.service">/{{ c.service }}</template></RouterLink>
                <span v-else>hors Compose</span>
                <span v-if="c.protected" class="rounded bg-slate-100 px-1.5">console</span>
              </p>
            </td>
            <td class="px-3 py-2">
              <span :class="['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', stateOf(c).cls]" :title="c.status"><FaIcon :icon="['fas', stateOf(c).icon]" /> {{ stateOf(c).text }}</span>
              <span v-if="c.state === 'running' && c.health && HEALTH[c.health]" :class="['ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium', HEALTH[c.health]?.cls]">{{ HEALTH[c.health]?.text }}</span>
              <p v-if="c.restartCount" class="mt-0.5 text-xs text-slate-500">{{ c.restartCount }} redémarrage(s)</p>
            </td>
            <td class="hidden px-3 py-2 md:table-cell">
              <template v-if="c.usage">
                <span class="tabular-nums">{{ c.usage.cpuPercent.toFixed(1) }} %</span>
                <div class="mt-1 h-1.5 w-20 overflow-hidden rounded bg-slate-100"><div class="h-full bg-blue-500" :style="{ width: `${Math.min(100, c.usage.cpuPercent)}%` }" /></div>
              </template>
              <span v-else class="text-slate-400">—</span>
            </td>
            <td class="hidden px-3 py-2 tabular-nums md:table-cell">{{ c.usage ? formatBytes(c.usage.memBytes) : "—" }}</td>
            <td class="hidden px-3 py-2 text-xs text-slate-500 xl:table-cell"><span v-if="c.startedAt" :title="fmtDate(c.startedAt)">{{ ago(c.startedAt, now) }}</span><span v-else>—</span></td>
            <td class="hidden px-3 py-2 text-xs tabular-nums text-slate-600 lg:table-cell">{{ portsText(c) || "—" }}</td>
            <td class="whitespace-nowrap px-3 py-2 text-right">
              <button class="rounded p-2 text-slate-600 hover:bg-slate-200" title="Logs" aria-label="Logs" @click="openDrawer(c, 'logs')"><FaIcon :icon="['fas', 'file-lines']" /></button>
              <button v-if="canConsole(c)" class="rounded p-2 text-slate-600 hover:bg-slate-200" title="Console" aria-label="Console" @click="openDrawer(c, 'console')"><FaIcon :icon="['fas', 'terminal']" /></button>
              <button class="rounded p-2 text-slate-600 hover:bg-slate-200" title="Stats" aria-label="Stats" @click="openDrawer(c, 'stats')"><FaIcon :icon="['fas', 'chart-line']" /></button>
              <button
                v-if="canAct(c)"
                class="rounded p-2 text-slate-600 hover:bg-slate-200 disabled:opacity-40"
                aria-haspopup="menu"
                :aria-expanded="openMenuKey === rowKey(c)"
                :aria-label="`Actions pour ${c.name}`"
                :disabled="busy !== null"
                @click.stop="toggleMenu(c, $event)"
              >
                <FaIcon :icon="busy === rowKey(c) ? ['fas', 'arrows-rotate'] : ['fas', 'ellipsis']" :spin="busy === rowKey(c)" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Vue tuiles -->
    <div v-if="viewMode === 'tiles' && visible.length" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <article v-for="c in sorted" :key="rowKey(c)" :class="['flex flex-col rounded-xl border p-4 shadow-sm', isProblem(c) ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white']">
        <header class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 class="truncate font-semibold" :title="c.name">{{ c.name }}</h2>
            <p class="truncate text-xs text-slate-500" :title="c.image">{{ c.image }}</p>
          </div>
          <span :class="['inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', stateOf(c).cls]" :title="c.status"><FaIcon :icon="['fas', stateOf(c).icon]" /> {{ stateOf(c).text }}</span>
        </header>
        <p class="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
          <FaIcon :icon="['fas', 'server']" /> {{ c.hostName }}
          <span v-if="c.hostPresence === 'offline'" class="rounded bg-red-100 px-1.5 text-red-800">hors ligne</span>
          <span>·</span>
          <RouterLink v-if="appLink(c)" :to="appLink(c) as string" class="hover:underline">{{ c.project }}<template v-if="c.service">/{{ c.service }}</template></RouterLink>
          <span v-else>hors Compose</span>
          <span v-if="c.protected" class="rounded bg-slate-100 px-1.5">console</span>
        </p>
        <p v-if="c.state === 'running' && c.health && HEALTH[c.health] && c.health !== 'healthy'" :class="['mt-2 inline-block self-start rounded-full px-2 py-0.5 text-xs font-medium', HEALTH[c.health]?.cls]">{{ HEALTH[c.health]?.text }}</p>
        <div v-if="c.usage" class="mt-3 space-y-2">
          <MeterBar label="CPU" icon="microchip" :percent="Math.min(100, c.usage.cpuPercent)" :detail="`${c.usage.cpuPercent.toFixed(1)} % d'un cœur`" />
          <p class="flex items-center gap-1.5 text-xs text-slate-600"><FaIcon :icon="['fas', 'memory']" class="text-slate-400" /> Mémoire : <span class="font-medium tabular-nums">{{ formatBytes(c.usage.memBytes) }}</span></p>
        </div>
        <p v-if="portsText(c)" class="mt-2 text-xs text-slate-500">Ports : <span class="tabular-nums">{{ portsText(c) }}</span></p>
        <footer class="mt-auto flex items-center justify-between gap-2 pt-4">
          <span class="text-xs text-slate-500"><template v-if="c.startedAt">démarré {{ ago(c.startedAt, now) }}</template></span>
          <div class="flex items-center">
            <button class="rounded p-2 text-slate-600 hover:bg-slate-100" title="Logs" aria-label="Logs" @click="openDrawer(c, 'logs')"><FaIcon :icon="['fas', 'file-lines']" /></button>
            <button v-if="canConsole(c)" class="rounded p-2 text-slate-600 hover:bg-slate-100" title="Console" aria-label="Console" @click="openDrawer(c, 'console')"><FaIcon :icon="['fas', 'terminal']" /></button>
            <button class="rounded p-2 text-slate-600 hover:bg-slate-100" title="Stats" aria-label="Stats" @click="openDrawer(c, 'stats')"><FaIcon :icon="['fas', 'chart-line']" /></button>
            <button v-if="canAct(c)" class="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40" aria-haspopup="menu" :aria-expanded="openMenuKey === rowKey(c)" :aria-label="`Actions pour ${c.name}`" :disabled="busy !== null" @click.stop="toggleMenu(c, $event)">
              <FaIcon :icon="busy === rowKey(c) ? ['fas', 'arrows-rotate'] : ['fas', 'ellipsis']" :spin="busy === rowKey(c)" />
            </button>
          </div>
        </footer>
      </article>
    </div>

    <!-- Menu d'actions de cycle de vie -->
    <div
      v-if="menuContainer"
      data-container-menu
      role="menu"
      class="fixed z-30 min-w-48 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
      :style="{ top: menuPos.top !== undefined ? `${menuPos.top}px` : undefined, bottom: menuPos.bottom !== undefined ? `${menuPos.bottom}px` : undefined, right: `${menuPos.right}px` }"
      @click.stop
      @keydown="onMenuKey"
    >
      <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-40" :disabled="menuContainer.state === 'running'" @click="menuAct(menuContainer, 'start')"><FaIcon :icon="['fas', 'play']" class="w-4" /> Démarrer</button>
      <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-40" :disabled="menuContainer.state !== 'running' && menuContainer.state !== 'restarting' && menuContainer.state !== 'paused'" @click="menuAct(menuContainer, 'stop')"><FaIcon :icon="['fas', 'stop']" class="w-4" /> Arrêter</button>
      <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none" @click="menuAct(menuContainer, 'restart')"><FaIcon :icon="['fas', 'arrows-rotate']" class="w-4" /> Redémarrer</button>
      <p v-if="menuContainer.appKind === 'managed'" class="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">Hors cycle Compose : un redéploiement de l'application remet le conteneur dans l'état défini.</p>
    </div>

    <ContainerDrawer v-if="drawer && drawerContainer" :container="drawerContainer" :tab="drawer.tab" @close="drawer = null" @update:tab="drawer.tab = $event" />
  </div>
</template>
