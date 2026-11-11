<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, api, type StackDetail } from "../api";
import ComposeTab from "./stack/ComposeTab.vue";
import FilesTab from "./stack/FilesTab.vue";
import HistoryTab from "./stack/HistoryTab.vue";
import LogsTab from "./stack/LogsTab.vue";
import MetricsTab from "./stack/MetricsTab.vue";
import ExportDialog from "../components/ExportDialog.vue";
import TerminalPanel from "../components/TerminalPanel.vue";
import { useSession } from "../stores/session";
import OperationsTab from "./stack/OperationsTab.vue";
import OverviewTab from "./stack/OverviewTab.vue";
import SecurityTab from "./stack/SecurityTab.vue";
import VariablesTab from "./stack/VariablesTab.vue";

const route = useRoute();
const router = useRouter();
const session = useSession();
const exporting = ref(false);
const id = computed(() => String(route.params.id));
const stack = ref<StackDetail | null>(null);
const error = ref("");
let timer: number | undefined;

// Onglets principaux ; « Configuration » et « Historique » regroupent des sections.
const tabs = [
  { key: "overview", label: "Vue d'ensemble", icon: "gauge-high" },
  { key: "config", label: "Configuration", icon: "file-code" },
  { key: "security", label: "Sécurité et versions", icon: "shield-halved" },
  { key: "metrics", label: "Métriques", icon: "chart-line" },
  { key: "logs", label: "Logs", icon: "terminal" },
  { key: "history", label: "Historique", icon: "clock-rotate-left" },
];
const SECTIONS_BASE: Record<string, { key: string; label: string; icon: string }[]> = {
  config: [
    { key: "compose", label: "Compose", icon: "file-code" },
    { key: "variables", label: "Variables", icon: "sliders" },
    { key: "files", label: "Fichiers", icon: "folder-open" },
  ],
  history: [
    { key: "revisions", label: "Révisions", icon: "clock-rotate-left" },
    { key: "operations", label: "Opérations", icon: "list-check" },
  ],
};
// « Logs » et « Terminal » partagent l'onglet ; le terminal n'apparaît que pour qui y a droit.
const SECTIONS = computed<Record<string, { key: string; label: string; icon: string }[]>>(() => ({
  ...SECTIONS_BASE,
  ...(session.info?.terminalAllowed ? { logs: [{ key: "logs", label: "Logs", icon: "terminal" }, { key: "terminal", label: "Terminal", icon: "terminal" }] } : {}),
}));

// L'onglet et la section vivent dans l'URL (?tab=config&section=variables) : liens directs et retour arrière.
const tab = computed(() => (tabs.some((t) => t.key === route.query.tab) ? String(route.query.tab) : "overview"));
const sections = computed(() => SECTIONS.value[tab.value] ?? []);
const section = computed(() => sections.value.find((s) => s.key === route.query.section)?.key ?? sections.value[0]?.key ?? "");
function go(nextTab: string, nextSection?: string) {
  void router.replace({ query: { ...(nextTab !== "overview" ? { tab: nextTab } : {}), ...(nextSection ? { section: nextSection } : {}) } });
}

async function load() {
  try {
    stack.value = await api<StackDetail>(`/api/v1/stacks/${id.value}`);
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <template v-if="stack">
      <div>
        <RouterLink to="/stacks" class="text-sm text-slate-500 hover:underline">← Applications</RouterLink>
        <h1 class="mt-1 flex items-center gap-3 text-2xl font-semibold">
          <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-lg text-blue-700"><FaIcon :icon="['fas', 'boxes-stacked']" /></span>
          {{ stack.name }}
        </h1>
        <p class="text-sm text-slate-500">
          Hôte {{ stack.hostName }} ({{ stack.hostPresence === "online" ? "en ligne" : "hors ligne" }}) ·
          enregistrée r{{ stack.currentRevision }} · déployée {{ stack.deployedRevision ? "r" + stack.deployedRevision : "jamais" }}
          <span v-if="stack.pendingDeploy" class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">modifications non déployées</span>
        </p>
      </div>

      <p v-if="stack.managedBy" role="note" class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        Cette application est générée et entretenue par la console ({{ stack.managedBy }}) : son Compose, ses variables et ses fichiers ne se modifient pas à la main.
        <RouterLink to="/settings?tab=registry" class="underline">Ouvrir ses paramètres</RouterLink> pour renouveler son mot de passe ou la détacher de la gestion automatique.
      </p>

      <div role="tablist" aria-label="Sections de la stack" class="flex flex-wrap gap-1 border-b border-slate-200">
        <button
          v-for="t in tabs"
          :key="t.key"
          role="tab"
          :aria-selected="tab === t.key"
          class="-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm"
          :class="tab === t.key ? 'border-blue-600 font-medium text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'"
          @click="go(t.key)"
        >
          <FaIcon :icon="['fas', t.icon]" />
          {{ t.label }}
        </button>
      </div>

      <div v-if="sections.length" class="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" :aria-label="`Sections de ${tab}`" class="flex flex-wrap gap-2">
          <button
            v-for="s in sections"
            :key="s.key"
            role="tab"
            :aria-selected="section === s.key"
            :class="['inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm', section === s.key ? 'border-blue-600 bg-blue-50 font-medium text-blue-700' : 'border-slate-300 text-slate-600 hover:bg-slate-100']"
            @click="go(tab, s.key)"
          >
            <FaIcon :icon="['fas', s.icon]" /> {{ s.label }}
          </button>
        </div>
        <button v-if="tab === 'config'" class="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100" title="Télécharger le Compose, le .env et les fichiers de la révision active" @click="exporting = true">
          <FaIcon :icon="['fas', 'download']" /> Exporter
        </button>
      </div>
      <ExportDialog v-if="exporting" :stack="stack" @close="exporting = false" />

      <OverviewTab v-if="tab === 'overview'" :stack="stack" @changed="load" />
      <!-- KeepAlive : un brouillon de Compose n'est pas perdu en passant à une autre section. -->
      <KeepAlive v-else-if="tab === 'config'">
        <ComposeTab v-if="section === 'compose'" :stack="stack" @changed="load" />
        <VariablesTab v-else-if="section === 'variables'" :stack="stack" @changed="load" />
        <FilesTab v-else :stack="stack" @changed="load" />
      </KeepAlive>
      <SecurityTab v-else-if="tab === 'security'" :stack="stack" @changed="load" />
      <MetricsTab v-else-if="tab === 'metrics'" :stack="stack" />
      <template v-else-if="tab === 'logs'">
        <TerminalPanel v-if="section === 'terminal'" :host-id="stack.hostId" :containers="stack.containers" />
        <LogsTab v-else :stack="stack" />
      </template>
      <template v-else-if="tab === 'history'">
        <HistoryTab v-if="section === 'revisions'" :stack="stack" @changed="load" />
        <OperationsTab v-else :stack="stack" />
      </template>
    </template>
    <p v-else-if="!error" class="text-slate-500">Chargement…</p>
  </div>
</template>
