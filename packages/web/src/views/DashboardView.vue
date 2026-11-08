<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ApiError,
  ago,
  api,
  fmtDate,
  formatBytes,
  type Application,
  type Dashboard,
  type DashboardAlert,
  type OverviewRange,
  type OverviewResult,
  type Severity,
  type VulnCounts,
} from "../api";
import AreaChart from "../charts/AreaChart.vue";
import DonutChart from "../charts/DonutChart.vue";
import { TONE } from "../charts/palette";
import CveHistoryChart from "../components/CveHistoryChart.vue";
import MeterBar from "../components/MeterBar.vue";
import PanelCard from "../components/PanelCard.vue";
import StatCard from "../components/StatCard.vue";

const data = ref<Dashboard | null>(null);
const overview = ref<OverviewResult | null>(null);
const applications = ref<Application[]>([]);
const error = ref("");
const hostId = ref("");
const stackId = ref("");
const range = ref<OverviewRange>("1h");
const now = ref(Date.now());
let timer: number | undefined;
let overviewTimer: number | undefined;

// Les listes de filtres viennent d'une vue non filtrée, pour rester complètes.
const allHosts = ref<{ id: string; name: string }[]>([]);
const allStacks = ref<{ id: string; name: string; hostId: string }[]>([]);

async function load() {
  try {
    const q = new URLSearchParams({ ...(hostId.value ? { hostId: hostId.value } : {}), ...(stackId.value ? { stackId: stackId.value } : {}) });
    data.value = await api<Dashboard>(`/api/v1/dashboard${q.size ? `?${q}` : ""}`);
    if (!hostId.value && !stackId.value) {
      allHosts.value = data.value.agents.items.map((a) => ({ id: a.id, name: a.name }));
      allStacks.value = data.value.stacks.items.map((s) => ({ id: s.id, name: s.name, hostId: s.hostId }));
    }
    applications.value = (await api<{ applications: Application[] }>("/api/v1/applications")).applications;
    now.value = Date.now();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  }
}

async function loadOverview() {
  try {
    overview.value = await api<OverviewResult>(`/api/v1/dashboard/overview?range=${range.value}`);
  } catch {
    /* les graphiques de ressources restent sur leur dernière valeur */
  }
}

const stacksForHost = computed(() => allStacks.value.filter((s) => !hostId.value || s.hostId === hostId.value));
watch(hostId, () => {
  if (stackId.value && !stacksForHost.value.some((s) => s.id === stackId.value)) stackId.value = "";
});
watch([hostId, stackId], () => void load());
watch(range, () => void loadOverview());

onMounted(() => {
  void load();
  void loadOverview();
  timer = window.setInterval(() => void load(), 10_000);
  overviewTimer = window.setInterval(() => void loadOverview(), 30_000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.clearInterval(overviewTimer);
});

const RANGES: { value: OverviewRange; label: string }[] = [
  { value: "1h", label: "1 h" },
  { value: "6h", label: "6 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 j" },
];

// --- Graphiques en anneau ------------------------------------------------------------------------

// Applications gérées ET observées (projets Compose qui tournent sans leur fichier), selon les filtres.
const filteredApps = computed(() =>
  applications.value.filter((a) => (!hostId.value || a.hostId === hostId.value) && (!stackId.value || a.stackId === stackId.value)),
);
// Top 5 des applications les plus vulnérables : critiques d'abord, puis élevées, puis le reste.
const topVulnerable = computed(() =>
  filteredApps.value
    .map((a) => {
      const c = { critical: 0, high: 0, other: 0 };
      for (const i of a.images) {
        if (!i.counts) continue;
        c.critical += i.counts.critical;
        c.high += i.counts.high;
        c.other += i.counts.medium + i.counts.low + i.counts.unknown;
      }
      return {
        key: `${a.hostId}/${a.name}`,
        name: a.name,
        hostName: a.hostName,
        counts: c,
        to: a.stackId ? `/stacks/${a.stackId}?tab=security` : `/hosts/${a.hostId}/projects/${encodeURIComponent(a.name)}?tab=security`,
      };
    })
    .filter((a) => a.counts.critical + a.counts.high + a.counts.other > 0)
    .sort((x, y) => y.counts.critical - x.counts.critical || y.counts.high - x.counts.high || y.counts.other - x.counts.other)
    .slice(0, 5),
);
const appCount = (status: string): number => filteredApps.value.filter((a) => a.status === status).length;
const stackItems = computed(() => [
  { label: "En marche", value: appCount("running"), color: TONE.ok },
  { label: "Dégradées", value: appCount("degraded"), color: TONE.bad },
  { label: "Arrêtées", value: appCount("stopped"), color: TONE.muted },
  { label: "Inconnues", value: appCount("unknown"), color: TONE.warn },
  { label: "Jamais déployées", value: appCount("not_deployed"), color: TONE.info },
]);
const managedCount = computed(() => filteredApps.value.filter((a) => a.kind === "managed").length);

// Un conteneur terminé avec le code 0 (migration, tâche ponctuelle) est « terminé », pas en erreur.
const containerItems = computed(() => {
  const c = data.value?.containers;
  if (!c) return [];
  const other = Math.max(0, c.stopped - c.completed - c.failed);
  return [
    { label: "En marche", value: Math.max(0, c.running - c.unhealthy), color: TONE.ok },
    { label: "Healthcheck en échec", value: c.unhealthy, color: TONE.warn },
    { label: "En échec", value: c.failed, color: TONE.bad },
    { label: "Terminés (code 0)", value: c.completed, color: TONE.info },
    { label: "Arrêtés / autres", value: other, color: TONE.muted },
  ];
});

const imageItems = computed(() => {
  const i = data.value?.security.images;
  return [
    { label: "CVE critiques", value: i?.withCritical ?? 0, color: TONE.bad },
    { label: "CVE élevées", value: i?.withHigh ?? 0, color: "#f97316" },
    { label: "Sans critique ni élevée", value: i?.noSevere ?? 0, color: TONE.ok },
    { label: "Jamais scannées", value: i?.never ?? 0, color: TONE.muted },
    { label: "Scan en échec", value: i?.failed ?? 0, color: TONE.warn },
  ];
});

// Répartition des CVE par gravité : avec le seuil des paramètres (« filtered »), ou sans (« all »).
const vulnMode = ref<"filtered" | "all">("filtered");
const vulnCounts = computed<VulnCounts | null>(() => data.value?.security.vulns[vulnMode.value] ?? null);
const vulnItems = computed(() => [
  { label: "Critiques", value: vulnCounts.value?.critical ?? 0, color: TONE.bad },
  { label: "Élevées", value: vulnCounts.value?.high ?? 0, color: "#f97316" },
  { label: "Moyennes", value: vulnCounts.value?.medium ?? 0, color: "#fbbf24" },
  { label: "Faibles", value: vulnCounts.value?.low ?? 0, color: "#0ea5e9" },
  { label: "Inconnues", value: vulnCounts.value?.unknown ?? 0, color: TONE.muted },
]);

// --- Ressources -------------------------------------------------------------------------------------

const ts = (iso: string): number => Date.parse(iso);
const totals = computed(() => overview.value?.totals.points ?? []);
const cpuSeries = computed(() => [{ name: "CPU des conteneurs", color: TONE.accent, points: totals.value.map((p) => ({ t: ts(p.t), v: p.cpu })) }]);
const memSeries = computed(() => [{ name: "Mémoire des conteneurs", color: TONE.violet, points: totals.value.map((p) => ({ t: ts(p.t), v: p.mem })) }]);
const netSeries = computed(() => [
  { name: "Reçu", color: TONE.ok, points: totals.value.map((p) => ({ t: ts(p.t), v: p.rxBps })) },
  { name: "Émis", color: TONE.warn, points: totals.value.map((p) => ({ t: ts(p.t), v: p.txBps })) },
]);

const pct = (used: number | null | undefined, total: number | null | undefined): number | null =>
  used === null || used === undefined || !total ? null : (used / total) * 100;

// --- Alertes -----------------------------------------------------------------------------------------

const sev: Record<Severity, { text: string; cls: string; icon: string }> = {
  critical: { text: "critique", cls: "bg-red-600 text-white", icon: "circle-xmark" },
  warning: { text: "attention", cls: "bg-amber-500 text-white", icon: "triangle-exclamation" },
  info: { text: "info", cls: "bg-slate-400 text-white", icon: "circle-info" },
};

interface AlertAction {
  label: string;
  to: string;
}

/** Action explicite pour traiter une alerte : ouvre la bonne page avec l'hôte, l'application et l'onglet présélectionnés. */
function actionFor(a: DashboardAlert): AlertAction | null {
  const t = a.target;
  const stackIdByName = (name: string | undefined): string | undefined => data.value?.stacks.items.find((s) => s.name === name)?.id;
  const stack = (id: string, query = ""): string => `/stacks/${id}${query}`;
  const observed = (query = ""): string => `/hosts/${t.hostId}/projects/${encodeURIComponent(t.project ?? "")}${query}`;
  switch (a.kind) {
    case "agent_offline":
    case "inventory_stale":
      return { label: "Voir l'hôte", to: "/hosts" };
    case "stack_degraded":
      return { label: "Voir les conteneurs", to: stack(t.id) };
    case "stack_stopped":
      return { label: "Ouvrir l'application", to: stack(t.id) };
    case "container_unhealthy":
      if (t.stackId) return { label: "Voir la raison de l'échec", to: stack(t.stackId) };
      return t.hostId && t.project ? { label: "Voir la raison de l'échec", to: observed() } : null;
    case "restart_loop":
      if (t.stackId) return { label: "Voir les logs", to: stack(t.stackId, `?tab=logs${t.service ? `&service=${encodeURIComponent(t.service)}` : ""}`) };
      return t.hostId && t.project ? { label: "Voir les logs", to: observed(`?tab=logs&container=${t.id}`) } : null;
    case "backup_failed":
    case "backup_not_configured":
      return { label: "Ouvrir la sauvegarde", to: "/settings?tab=git" };
    case "vulnerabilities_critical":
    case "scan_failed":
    case "scan_stale": {
      const only = t.stacks?.length === 1 ? stackIdByName(t.stacks[0]) : undefined;
      return only ? { label: "Voir les vulnérabilités", to: stack(only, "?tab=security") } : { label: "Voir les images", to: "/images" };
    }
    case "image_update":
    case "image_check_failed":
      return { label: "Voir les versions", to: stack(t.id, "?tab=security") };
    case "operation_unknown": {
      const id = stackIdByName(t.stackName);
      return id ? { label: "Voir l'opération", to: stack(id, `?tab=history&section=operations&operation=${t.id}`) } : null;
    }
    default:
      return null;
  }
}

// « À traiter » : les alertes graves d'abord (le serveur les trie déjà), les informations seulement à la demande.
const TODO_LIMIT = 6;
const showInfo = ref(false);
const showAllTodo = ref(false);
const todo = computed(() => (data.value?.alerts ?? []).filter((a) => showInfo.value || a.severity !== "info"));
const todoShown = computed(() => (showAllTodo.value ? todo.value : todo.value.slice(0, TODO_LIMIT)));

const alertCounts = computed(() => {
  const c = { critical: 0, warning: 0, info: 0 };
  for (const a of data.value?.alerts ?? []) c[a.severity]++;
  return c;
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-2xl font-semibold">Tableau de bord</h1>
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <label>
          <span class="sr-only">Hôte</span>
          <select v-model="hostId" aria-label="Hôte" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
            <option value="">Tous les hôtes</option>
            <option v-for="h in allHosts" :key="h.id" :value="h.id">{{ h.name }}</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Application</span>
          <select v-model="stackId" aria-label="Application" class="rounded-md border border-slate-300 bg-white px-3 py-1.5">
            <option value="">Toutes les applications</option>
            <option v-for="s in stacksForHost" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
      </div>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>

    <template v-if="data">
      <section aria-label="Indicateurs" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Agents" icon="server" :value="`${data.agents.online} / ${data.agents.total}`" :hint="data.agents.offline ? `${data.agents.offline} hors ligne` : 'tous en ligne'" :tone="data.agents.offline ? 'bad' : 'ok'" to="/statut" />
        <StatCard label="Applications" icon="boxes-stacked" :value="filteredApps.length" :hint="`${managedCount} gérée(s) · ${filteredApps.length - managedCount} observée(s)`" to="/stacks" />
        <StatCard label="Conteneurs" icon="cube" :value="`${data.containers.running} / ${data.containers.total}`" hint="en marche" :tone="data.containers.failed ? 'bad' : 'ok'" />
        <StatCard
          label="Alertes"
          icon="triangle-exclamation"
          :value="alertCounts.critical + alertCounts.warning + alertCounts.info"
          :hint="`${alertCounts.critical} critique(s) · ${alertCounts.warning} attention`"
          :tone="alertCounts.critical ? 'bad' : alertCounts.warning ? 'warn' : 'ok'"
        />
        <StatCard
          label="Vulnérabilités"
          icon="shield-halved"
          :value="data.security.images.critical + data.security.images.high"
          :hint="`${data.security.images.critical} critique(s) · ${data.security.images.high} élevée(s)`"
          :tone="data.security.images.critical ? 'bad' : data.security.images.high ? 'warn' : 'ok'"
          to="/images"
        />
        <StatCard label="Mises à jour" icon="arrows-rotate" :value="data.security.updates.available" hint="d'images disponibles" :tone="data.security.updates.available ? 'warn' : 'ok'" to="/images" />
      </section>

      <PanelCard title="À traiter" icon="triangle-exclamation" :subtitle="todo.length ? `${alertCounts.critical} critique(s) · ${alertCounts.warning} attention` : undefined">
        <template #actions>
          <label v-if="alertCounts.info" class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="showInfo" type="checkbox" /> Afficher les informations ({{ alertCounts.info }})</label>
        </template>
        <p v-if="todo.length === 0" class="flex items-center gap-2 text-sm text-green-700"><FaIcon :icon="['fas', 'circle-check']" /> Rien à traiter : aucune alerte active.</p>
        <ul v-else class="divide-y divide-slate-200">
          <li v-for="a in todoShown" :key="a.id" class="flex flex-wrap items-start gap-3 py-3 text-sm first:pt-0 last:pb-0">
            <span class="mt-0.5 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs" :class="sev[a.severity].cls"><FaIcon :icon="['fas', sev[a.severity].icon]" />{{ sev[a.severity].text }}</span>
            <div class="min-w-0 flex-1">
              <p class="font-medium">{{ a.title }}</p>
              <p class="text-slate-600">{{ a.message }}</p>
              <p v-if="a.since" class="mt-0.5 text-xs text-slate-500" :title="fmtDate(a.since)">depuis {{ ago(a.since, now).replace("il y a ", "") }}</p>
            </div>
            <RouterLink v-if="actionFor(a)" :to="(actionFor(a) as AlertAction).to" class="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100">{{ (actionFor(a) as AlertAction).label }}</RouterLink>
          </li>
        </ul>
        <button v-if="todo.length > TODO_LIMIT" class="mt-3 text-sm underline" @click="showAllTodo = !showAllTodo">{{ showAllTodo ? "Réduire la liste" : `Voir les ${todo.length - TODO_LIMIT} autre(s)` }}</button>
      </PanelCard>

      <section aria-label="Répartition" class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
        <PanelCard title="Applications" icon="boxes-stacked" subtitle="Gérées et observées"><DonutChart title="Applications" center-label="applications" :items="stackItems" /></PanelCard>
        <PanelCard title="Conteneurs" icon="cube" subtitle="Un conteneur terminé avec le code 0 n'est pas une erreur"><DonutChart title="Conteneurs" center-label="conteneurs" :items="containerItems" /></PanelCard>
        <PanelCard title="Images" icon="layer-group" subtitle="Seules les CVE critiques et élevées comptent"><DonutChart title="Images" center-label="images" :items="imageItems" /></PanelCard>
        <PanelCard title="Vulnérabilités" icon="shield-halved" :subtitle="vulnMode === 'filtered' ? 'Selon le seuil de gravité des paramètres' : 'Toutes les gravités, seuil ignoré'">
          <template #actions>
            <div role="group" aria-label="Filtrage des vulnérabilités" class="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-300 text-xs">
              <button :aria-pressed="vulnMode === 'filtered'" :class="['px-2 py-1', vulnMode === 'filtered' ? 'bg-blue-600 text-white' : 'hover:bg-slate-100']" @click="vulnMode = 'filtered'">Filtrées</button>
              <button :aria-pressed="vulnMode === 'all'" :class="['px-2 py-1', vulnMode === 'all' ? 'bg-blue-600 text-white' : 'hover:bg-slate-100']" @click="vulnMode = 'all'">Toutes</button>
            </div>
          </template>
          <DonutChart title="Vulnérabilités" center-label="vulnérabilités" :items="vulnItems" />
        </PanelCard>
      </section>

      <section aria-label="Ressources" class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">Ressources</h2>
          <div class="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm" role="group" aria-label="Période">
            <button
              v-for="r in RANGES"
              :key="r.value"
              :aria-pressed="range === r.value"
              :class="['rounded px-3 py-1', range === r.value ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100']"
              @click="range = r.value"
            >
{{ r.label }}
</button>
          </div>
        </div>
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <PanelCard title="CPU des conteneurs" icon="microchip" subtitle="100 % = un cœur complet"><AreaChart title="CPU des conteneurs" unit="percent" :series="cpuSeries" /></PanelCard>
          <PanelCard title="Mémoire des conteneurs" icon="memory"><AreaChart title="Mémoire des conteneurs" unit="bytes" :series="memSeries" /></PanelCard>
          <PanelCard title="Réseau" icon="network-wired"><AreaChart title="Réseau" unit="bps" :series="netSeries" /></PanelCard>
          <PanelCard title="Évolution des CVE" icon="shield-halved" :subtitle="vulnMode === 'filtered' ? 'Par gravité, selon le seuil des paramètres' : 'Par gravité, toutes les gravités'">
            <CveHistoryChart :host-id="hostId || undefined" :stack-id="stackId || undefined" :mode="vulnMode" />
          </PanelCard>
        </div>
        <div class="grid gap-4 xl:grid-cols-4">
          <PanelCard title="Machines hôtes" icon="server" subtitle="Dernier relevé">
            <p v-if="!overview || overview.hosts.length === 0" class="text-sm text-slate-500">Aucun hôte.</p>
            <ul v-else class="space-y-5">
              <li v-for="h in overview.hosts" :key="h.hostId" class="space-y-2">
                <p class="text-sm font-medium">{{ h.name }}<span v-if="h.cpus" class="ml-2 text-xs font-normal text-slate-500">{{ h.cpus }} cœur(s)</span></p>
                <template v-if="h.latest">
                  <MeterBar label="CPU" icon="microchip" :percent="h.latest.cpuPercent" />
                  <MeterBar label="Mémoire" icon="memory" :percent="pct(h.latest.memUsed, h.latest.memTotal)" :detail="h.latest.memTotal ? `${formatBytes(h.latest.memUsed ?? 0)} / ${formatBytes(h.latest.memTotal)}` : undefined" />
                  <MeterBar label="Disque" icon="hard-drive" :percent="pct(h.latest.diskUsed, h.latest.diskTotal)" :detail="h.latest.diskTotal ? `${formatBytes(h.latest.diskUsed ?? 0)} / ${formatBytes(h.latest.diskTotal)}` : undefined" />
                </template>
                <p v-else class="text-xs text-slate-500">Pas encore de relevé de la machine (l'agent doit être à jour et en ligne).</p>
              </li>
            </ul>
          </PanelCard>
          <PanelCard title="Top 5 CPU" icon="microchip" subtitle="Applications les plus gourmandes sur la période">
            <p v-if="!overview || overview.top.cpu.length === 0" class="text-sm text-slate-500">Aucune mesure.</p>
            <ol v-else class="space-y-2 text-sm">
              <li v-for="(a, i) in overview.top.cpu" :key="a.project + a.hostName" class="flex items-center gap-3">
                <span class="w-5 text-center text-xs text-slate-400">{{ i + 1 }}</span>
                <span class="min-w-0 flex-1 truncate">{{ a.project }}<span class="ml-1 text-xs text-slate-400">{{ a.hostName }}</span></span>
                <span class="tabular-nums">{{ (a.value / 100).toFixed(2) }} cœur(s)</span>
              </li>
            </ol>
          </PanelCard>
          <PanelCard title="Top 5 mémoire" icon="memory" subtitle="Applications les plus gourmandes sur la période">
            <p v-if="!overview || overview.top.mem.length === 0" class="text-sm text-slate-500">Aucune mesure.</p>
            <ol v-else class="space-y-2 text-sm">
              <li v-for="(a, i) in overview.top.mem" :key="a.project + a.hostName" class="flex items-center gap-3">
                <span class="w-5 text-center text-xs text-slate-400">{{ i + 1 }}</span>
                <span class="min-w-0 flex-1 truncate">{{ a.project }}<span class="ml-1 text-xs text-slate-400">{{ a.hostName }}</span></span>
                <span class="tabular-nums">{{ formatBytes(a.value) }}</span>
              </li>
            </ol>
          </PanelCard>
          <PanelCard title="Top 5 CVE" icon="shield-halved" subtitle="Critiques d'abord, puis élevées (seuil des paramètres)">
            <p v-if="topVulnerable.length === 0" class="text-sm text-slate-500">Aucune application avec des CVE.</p>
            <ol v-else class="space-y-2 text-sm">
              <li v-for="(a, i) in topVulnerable" :key="a.key" class="flex items-center gap-3">
                <span class="w-5 text-center text-xs text-slate-400">{{ i + 1 }}</span>
                <RouterLink :to="a.to" class="min-w-0 flex-1 truncate hover:underline" :title="`Ouvrir la sécurité de ${a.name}`">{{ a.name }}<span class="ml-1 text-xs text-slate-400">{{ a.hostName }}</span></RouterLink>
                <span class="whitespace-nowrap text-xs tabular-nums">
                  <span class="font-semibold text-red-600" title="Critiques">{{ a.counts.critical }}</span> ·
                  <span class="font-semibold text-orange-500" title="Élevées">{{ a.counts.high }}</span> ·
                  <span class="text-slate-500" title="Autres">{{ a.counts.other }}</span>
                </span>
              </li>
            </ol>
          </PanelCard>
        </div>
      </section>
    </template>
  </div>
</template>
