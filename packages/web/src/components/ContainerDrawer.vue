<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { Container, ContainerRow } from "../api";
import { useSession } from "../stores/session";
import ContainerLogs from "./ContainerLogs.vue";
import ContainerStats from "./ContainerStats.vue";
import TerminalPanel from "./TerminalPanel.vue";

export type DrawerTab = "logs" | "console" | "stats";

// Tiroir latéral : logs en direct, console et statistiques d'un conteneur, sans quitter la liste.
const props = defineProps<{ container: ContainerRow; tab: DrawerTab }>();
const emit = defineEmits<{ close: []; "update:tab": [tab: DrawerTab] }>();
const session = useSession();

const canConsole = computed(() => session.info?.terminalAllowed === true && !props.container.protected);
const tabs = computed(() => [
  { key: "logs" as const, label: "Logs", icon: "file-lines" },
  ...(canConsole.value ? [{ key: "console" as const, label: "Console", icon: "terminal" }] : []),
  { key: "stats" as const, label: "Stats", icon: "chart-line" },
]);
const running = computed(() => props.container.state === "running");
// Le terminal attend la forme « Container » du protocole.
const asContainer = computed<Container>(() => ({
  id: props.container.id,
  names: [props.container.name],
  image: props.container.image,
  state: props.container.state,
  status: props.container.status,
  ...(props.container.service ? { composeService: props.container.service } : {}),
}));

const panel = ref<HTMLElement | null>(null);
let opener: Element | null = null;
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => {
  opener = document.activeElement;
  document.addEventListener("keydown", onKey);
  void nextTick(() => panel.value?.focus());
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  if (opener instanceof HTMLElement) opener.focus();
});
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end" role="presentation">
    <div class="absolute inset-0 bg-slate-900/40" @click="emit('close')" />
    <aside
      ref="panel"
      role="dialog"
      aria-modal="true"
      :aria-label="`Conteneur ${container.name}`"
      tabindex="-1"
      class="relative flex h-full w-full max-w-3xl flex-col bg-white shadow-xl focus:outline-none"
    >
      <header class="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-lg font-semibold">{{ container.name }}</h2>
          <p class="truncate text-xs text-slate-500">
            {{ container.hostName }} · {{ container.image }}
            <template v-if="container.project"> · {{ container.project }}<template v-if="container.service">/{{ container.service }}</template></template>
          </p>
          <p class="mt-1 text-xs"><span :class="running ? 'text-green-700' : 'text-slate-600'">{{ container.status || container.state }}</span></p>
        </div>
        <button class="rounded p-2 text-slate-600 hover:bg-slate-100" aria-label="Fermer le tiroir" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div role="tablist" aria-label="Sections du conteneur" class="flex gap-1 border-b border-slate-200 px-4">
        <button
          v-for="t in tabs"
          :key="t.key"
          role="tab"
          :aria-selected="tab === t.key"
          :class="['inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm', tab === t.key ? 'border-blue-600 font-medium text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900']"
          @click="emit('update:tab', t.key)"
        >
          <FaIcon :icon="['fas', t.icon]" /> {{ t.label }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
        <p v-if="container.hostPresence === 'offline'" class="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">Agent hors ligne : logs et console indisponibles, l'état affiché est le dernier connu.</p>
        <div v-if="tab === 'logs'" class="flex h-full min-h-[24rem] flex-col"><ContainerLogs :key="container.id" :host-id="container.hostId" :container-id="container.id" /></div>
        <TerminalPanel v-else-if="tab === 'console' && canConsole" :key="container.id" :host-id="container.hostId" :containers="[asContainer]" />
        <ContainerStats v-else-if="tab === 'stats'" :key="container.id" :host-id="container.hostId" :container-id="container.id" :running="running" :usage="container.usage" />
      </div>
    </aside>
  </div>
</template>
