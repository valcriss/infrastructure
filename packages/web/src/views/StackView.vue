<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { ApiError, api, type StackDetail } from "../api";
import ComposeTab from "./stack/ComposeTab.vue";
import FilesTab from "./stack/FilesTab.vue";
import HistoryTab from "./stack/HistoryTab.vue";
import LogsTab from "./stack/LogsTab.vue";
import MetricsTab from "./stack/MetricsTab.vue";
import OperationsTab from "./stack/OperationsTab.vue";
import OverviewTab from "./stack/OverviewTab.vue";
import VariablesTab from "./stack/VariablesTab.vue";

const route = useRoute();
const id = computed(() => String(route.params.id));
const stack = ref<StackDetail | null>(null);
const error = ref("");
const tab = ref("overview");
let timer: number | undefined;

const tabs = [
  { key: "overview", label: "Vue d'ensemble" },
  { key: "compose", label: "Compose" },
  { key: "variables", label: "Variables" },
  { key: "files", label: "Fichiers" },
  { key: "metrics", label: "Métriques" },
  { key: "logs", label: "Logs" },
  { key: "history", label: "Historique" },
  { key: "operations", label: "Opérations" },
];

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
        <RouterLink to="/stacks" class="text-sm text-slate-500 underline">← Stacks</RouterLink>
        <h1 class="mt-1 text-2xl font-semibold">{{ stack.name }}</h1>
        <p class="text-sm text-slate-500">
          Hôte {{ stack.hostName }} ({{ stack.hostPresence === "online" ? "en ligne" : "hors ligne" }}) ·
          enregistrée r{{ stack.currentRevision }} · déployée {{ stack.deployedRevision ? "r" + stack.deployedRevision : "jamais" }}
          <span v-if="stack.pendingDeploy" class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">modifications non déployées</span>
        </p>
      </div>

      <div role="tablist" aria-label="Sections de la stack" class="flex flex-wrap gap-1 border-b border-slate-200">
        <button
          v-for="t in tabs"
          :key="t.key"
          role="tab"
          :aria-selected="tab === t.key"
          class="-mb-px border-b-2 px-3 py-2 text-sm"
          :class="tab === t.key ? 'border-slate-900 font-medium' : 'border-transparent text-slate-600 hover:text-slate-900'"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>

      <OverviewTab v-if="tab === 'overview'" :stack="stack" @changed="load" />
      <ComposeTab v-else-if="tab === 'compose'" :stack="stack" @changed="load" />
      <VariablesTab v-else-if="tab === 'variables'" :stack="stack" @changed="load" />
      <FilesTab v-else-if="tab === 'files'" :stack="stack" @changed="load" />
      <MetricsTab v-else-if="tab === 'metrics'" :stack="stack" />
      <LogsTab v-else-if="tab === 'logs'" :stack="stack" />
      <HistoryTab v-else-if="tab === 'history'" :stack="stack" @changed="load" />
      <OperationsTab v-else-if="tab === 'operations'" :stack="stack" />
    </template>
    <p v-else-if="!error" class="text-slate-500">Chargement…</p>
  </div>
</template>
