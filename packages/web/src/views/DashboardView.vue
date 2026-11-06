<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ApiError,
  ago,
  api,
  fmtDate,
  formatBytes,
  type BackupState,
  type Dashboard,
  type DashboardAlert,
  type Severity,
  type StackStatus,
} from "../api";

const data = ref<Dashboard | null>(null);
const error = ref("");
const hostId = ref("");
const stackId = ref("");
const now = ref(Date.now());
let timer: number | undefined;

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
    now.value = Date.now();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  }
}

const stacksForHost = computed(() => allStacks.value.filter((s) => !hostId.value || s.hostId === hostId.value));
watch(hostId, () => {
  if (stackId.value && !stacksForHost.value.some((s) => s.id === stackId.value)) stackId.value = "";
});
watch([hostId, stackId], () => void load());

const status: Record<StackStatus, { text: string; cls: string }> = {
  running: { text: "en marche", cls: "bg-green-100 text-green-800" },
  degraded: { text: "dégradée", cls: "bg-red-100 text-red-800" },
  stopped: { text: "arrêtée", cls: "bg-slate-300 text-slate-800" },
  unknown: { text: "inconnue", cls: "bg-amber-100 text-amber-800" },
  not_deployed: { text: "jamais déployée", cls: "bg-slate-200 text-slate-700" },
};
const sev: Record<Severity, { text: string; cls: string }> = {
  critical: { text: "critique", cls: "bg-red-600 text-white" },
  warning: { text: "attention", cls: "bg-amber-500 text-white" },
  info: { text: "info", cls: "bg-slate-400 text-white" },
};
const backupText: Record<BackupState, string> = {
  not_configured: "non configurée",
  disabled: "désactivée",
  ok: "à jour",
  pending: "en attente de push",
  error: "en échec",
  blocked: "bloquée",
};

function link(a: DashboardAlert): string | null {
  if (a.target.type === "stack") return `/stacks/${a.target.id}`;
  if (a.target.type === "host") return "/hosts";
  if (a.target.type === "backup") return "/backup";
  return null;
}

const alertCounts = computed(() => {
  const c = { critical: 0, warning: 0, info: 0 };
  for (const a of data.value?.alerts ?? []) c[a.severity]++;
  return c;
});

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <h1 class="text-2xl font-semibold">Tableau de bord</h1>
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <label>
          <span class="sr-only">Environnement</span>
          <select aria-label="Environnement" class="rounded border border-slate-300 bg-white px-3 py-1.5" disabled>
            <option>Environnement : standalone</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Hôte</span>
          <select v-model="hostId" aria-label="Hôte" class="rounded border border-slate-300 bg-white px-3 py-1.5">
            <option value="">Tous les hôtes</option>
            <option v-for="h in allHosts" :key="h.id" :value="h.id">{{ h.name }}</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Stack</span>
          <select v-model="stackId" aria-label="Stack" class="rounded border border-slate-300 bg-white px-3 py-1.5">
            <option value="">Toutes les stacks</option>
            <option v-for="s in stacksForHost" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
      </div>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>

    <template v-if="data">
      <section aria-label="Résumé" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <p class="text-xs uppercase text-slate-500">Agents</p>
          <p class="mt-1 text-2xl font-semibold" :class="data.agents.offline ? 'text-red-700' : ''">{{ data.agents.online }}<span class="text-base font-normal text-slate-500"> / {{ data.agents.total }} en ligne</span></p>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <p class="text-xs uppercase text-slate-500">Stacks</p>
          <p class="mt-1 flex flex-wrap gap-x-3 text-sm">
            <span class="text-green-700">{{ data.stacks.counts.running }} en marche</span>
            <span :class="data.stacks.counts.degraded ? 'font-semibold text-red-700' : 'text-slate-500'">{{ data.stacks.counts.degraded }} dégradée(s)</span>
            <span class="text-slate-600">{{ data.stacks.counts.stopped }} arrêtée(s)</span>
            <span :class="data.stacks.counts.unknown ? 'font-semibold text-amber-700' : 'text-slate-500'">{{ data.stacks.counts.unknown }} inconnue(s)</span>
          </p>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <p class="text-xs uppercase text-slate-500">Conteneurs</p>
          <p class="mt-1 text-2xl font-semibold">{{ data.containers.running }}<span class="text-base font-normal text-slate-500"> / {{ data.containers.total }} en marche</span></p>
          <p class="text-xs text-slate-500">
            {{ data.containers.unhealthy }} en échec de healthcheck · {{ data.containers.noHealthcheck }} sans healthcheck
            <span v-if="data.containers.unmanagedProjects">· {{ data.containers.unmanagedProjects }} projet(s) non géré(s)</span>
          </p>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <p class="text-xs uppercase text-slate-500">Alertes</p>
          <p class="mt-1 flex gap-3 text-sm">
            <span :class="alertCounts.critical ? 'font-semibold text-red-700' : 'text-slate-500'">{{ alertCounts.critical }} critique(s)</span>
            <span :class="alertCounts.warning ? 'font-semibold text-amber-700' : 'text-slate-500'">{{ alertCounts.warning }} attention</span>
            <span class="text-slate-500">{{ alertCounts.info }} info</span>
          </p>
          <p v-if="data.backup" class="mt-1 text-xs text-slate-500">
            Sauvegarde Git : <RouterLink to="/backup" class="underline">{{ backupText[data.backup.state] }}</RouterLink>
            <span v-if="data.backup.lastPushAt"> · dernier push {{ ago(data.backup.lastPushAt, now) }}</span>
          </p>
        </div>
      </section>

      <section aria-label="Alertes">
        <h2 class="mb-2 text-lg font-semibold">Alertes</h2>
        <p v-if="data.alerts.length === 0" class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">Aucune alerte active.</p>
        <ul v-else class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          <li v-for="a in data.alerts" :key="a.id" class="flex flex-wrap items-start gap-3 p-4 text-sm">
            <span class="mt-0.5 rounded px-2 py-0.5 text-xs" :class="sev[a.severity].cls">{{ sev[a.severity].text }}</span>
            <div class="min-w-0 flex-1">
              <p class="font-medium">
                <RouterLink v-if="link(a)" :to="link(a) as string" class="underline">{{ a.title }}</RouterLink>
                <template v-else>{{ a.title }}</template>
              </p>
              <p class="text-slate-600">{{ a.message }}</p>
            </div>
            <span v-if="a.since" class="text-xs text-slate-500" :title="fmtDate(a.since)">depuis {{ ago(a.since, now).replace("il y a ", "") }}</span>
          </li>
        </ul>
      </section>

      <section aria-label="Stacks">
        <h2 class="mb-2 text-lg font-semibold">Stacks</h2>
        <p v-if="data.stacks.items.length === 0" class="text-sm text-slate-500">Aucune stack pour ce filtre.</p>
        <div v-else class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr><th class="px-4 py-2">Stack</th><th class="px-4 py-2">Hôte</th><th class="px-4 py-2">État</th><th class="px-4 py-2">Conteneurs</th><th class="px-4 py-2">Dernière observation</th></tr>
            </thead>
            <tbody>
              <tr v-for="s in data.stacks.items" :key="s.id" class="border-t border-slate-100 align-top">
                <td class="px-4 py-2">
                  <RouterLink :to="`/stacks/${s.id}`" class="font-medium underline">{{ s.name }}</RouterLink>
                  <p class="text-xs text-slate-500">r{{ s.currentRevision }}{{ s.deployedRevision && s.deployedRevision !== s.currentRevision ? ` · déployée r${s.deployedRevision}` : "" }}</p>
                </td>
                <td class="px-4 py-2">{{ s.hostName }}<span v-if="s.hostPresence === 'offline'" class="ml-1 rounded bg-red-100 px-1.5 text-xs text-red-800">hors ligne</span></td>
                <td class="px-4 py-2">
                  <span class="rounded px-2 py-0.5 text-xs" :class="status[s.status].cls">{{ status[s.status].text }}</span>
                  <p class="mt-1 max-w-sm text-xs text-slate-500">{{ s.reason }}</p>
                </td>
                <td class="px-4 py-2 text-xs">
                  {{ s.containers.running }}/{{ s.containers.total }} en marche
                  <p v-if="s.containers.unhealthy" class="text-red-700">{{ s.containers.unhealthy }} healthcheck en échec</p>
                  <p v-if="s.containers.noHealthcheck" class="text-slate-500">{{ s.containers.noHealthcheck }} sans healthcheck</p>
                </td>
                <td class="px-4 py-2 text-xs text-slate-500" :title="s.observedAt ? fmtDate(s.observedAt) : ''">{{ ago(s.observedAt, now) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="grid gap-8 lg:grid-cols-2">
        <section aria-label="Agents">
          <h2 class="mb-2 text-lg font-semibold">Agents</h2>
          <ul class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white text-sm">
            <li v-for="a in data.agents.items" :key="a.id" class="p-4">
              <div class="flex items-center gap-2">
                <span class="inline-block h-2.5 w-2.5 rounded-full" :class="a.presence === 'online' ? 'bg-green-500' : 'bg-red-500'" aria-hidden="true"></span>
                <span class="font-medium">{{ a.name }}</span>
                <span class="text-xs text-slate-500">{{ a.presence === "online" ? "en ligne" : `hors ligne · vu ${ago(a.lastSeenAt, now)}` }}</span>
              </div>
              <p class="mt-1 text-xs text-slate-500">
                Docker {{ a.dockerVersion ?? "?" }} · agent {{ a.agentVersion ?? "?" }}
                <template v-if="a.hostInfo"> · {{ a.hostInfo.cpus }} CPU · {{ formatBytes(a.hostInfo.memTotalBytes) }} · {{ a.hostInfo.images }} image(s)</template>
              </p>
            </li>
          </ul>
        </section>

        <section aria-label="Utilisation">
          <h2 class="mb-2 text-lg font-semibold">Utilisation des conteneurs</h2>
          <p v-if="data.usage.top.length === 0" class="text-sm text-slate-500">Aucune métrique récente (collecte toutes les 30 s ; les hôtes hors ligne sont exclus).</p>
          <table v-else class="w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-left text-sm">
            <thead class="text-xs text-slate-500"><tr><th class="px-3 py-2">Conteneur</th><th class="px-3 py-2">CPU</th><th class="px-3 py-2">Mémoire</th></tr></thead>
            <tbody>
              <tr v-for="c in data.usage.top" :key="c.containerId" class="border-t border-slate-100">
                <td class="px-3 py-1.5">{{ c.service ?? c.name }}<span v-if="c.project" class="ml-1 text-xs text-slate-400">{{ c.project }}</span></td>
                <td class="px-3 py-1.5">{{ c.cpuPercent === null ? "…" : c.cpuPercent.toFixed(1) + " %" }}</td>
                <td class="px-3 py-1.5">{{ formatBytes(c.memBytes) }}<span class="text-xs text-slate-400"> / {{ formatBytes(c.memLimitBytes) }}</span></td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
      <p class="text-xs text-slate-500">
        Un hôte hors ligne ou une observation périmée donnent l'état « inconnue », jamais « arrêtée » : la dernière observation est conservée et datée.
        Les contrôles HTTP externes ne sont pas inclus : seuls les healthchecks Docker sont pris en compte (« sans healthcheck » = non configuré, ce qui n'est pas une panne).
      </p>
    </template>
    <p v-else-if="!error" class="text-slate-500">Chargement…</p>
  </div>
</template>
