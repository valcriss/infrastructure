<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import type { Container, ProjectRef } from "../../api";

// `project` : projet observé (non géré) ; on choisit alors un conteneur précis au lieu de « tous les services ».
const props = defineProps<{ stack: { id: string; containers: Container[] }; project?: ProjectRef }>();

const MAX_LINES = 5000;
const service = ref("");
const tail = ref(100);
const filter = ref("");
const follow = ref(true);
const lines = ref<string[]>([]);
const status = ref<"idle" | "connecting" | "live" | "ended">("idle");
const message = ref("");
const box = ref<HTMLElement | null>(null);
let source: EventSource | null = null;

const services = computed(() => [...new Set(props.stack.containers.map((c) => c.composeService).filter((s): s is string => !!s))].sort());
const choices = computed(() =>
  props.project
    ? props.stack.containers.map((c) => ({ value: c.id, label: c.composeService ? `${c.composeService} (${c.names[0] ?? c.id.slice(0, 12)})` : (c.names[0] ?? c.id.slice(0, 12)) }))
    : services.value.map((s) => ({ value: s, label: s })),
);
if (props.project) service.value = props.stack.containers[0]?.id ?? "";
const shown = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return f ? lines.value.filter((l) => l.toLowerCase().includes(f)) : lines.value;
});

function stop() {
  source?.close();
  source = null;
  if (status.value === "live" || status.value === "connecting") {
    status.value = "ended";
    message.value = "Flux arrêté.";
  }
}

function start() {
  stop();
  lines.value = [];
  message.value = "";
  status.value = "connecting";
  const q = new URLSearchParams({ tail: String(tail.value), ...(service.value ? { [props.project ? "container" : "service"]: service.value } : {}) });
  source = new EventSource(props.project ? `/api/v1/hosts/${props.project.hostId}/projects/${encodeURIComponent(props.project.name)}/logs?${q}` : `/api/v1/stacks/${props.stack.id}/logs?${q}`);
  source.onopen = () => (status.value = "live");
  source.addEventListener("lines", (e) => {
    const batch = JSON.parse((e as MessageEvent<string>).data) as string[];
    lines.value = [...lines.value, ...batch].slice(-MAX_LINES);
    if (follow.value) void nextTick(() => box.value && (box.value.scrollTop = box.value.scrollHeight));
  });
  source.addEventListener("end", (e) => {
    message.value = JSON.parse((e as MessageEvent<string>).data) as string;
    status.value = "ended";
    source?.close();
    source = null;
  });
  // Une erreur HTTP (agent hors ligne, trop de flux…) ferme le flux sans reconnexion automatique.
  source.onerror = () => {
    if (status.value !== "ended") {
      message.value = "Flux indisponible ou interrompu (agent hors ligne, limite de flux atteinte ou session expirée).";
      status.value = "ended";
    }
    source?.close();
    source = null;
  };
}

onBeforeUnmount(stop);
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-end gap-3 text-sm">
      <label class="block">
        <span class="font-medium">{{ project ? "Conteneur" : "Service" }}</span>
        <select v-model="service" class="mt-1 block rounded border border-slate-300 px-3 py-2">
          <option v-if="!project" value="">Tous</option>
          <option v-for="c in choices" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </label>
      <label class="block">
        <span class="font-medium">Dernières lignes</span>
        <select v-model.number="tail" class="mt-1 block rounded border border-slate-300 px-3 py-2">
          <option :value="0">0</option><option :value="100">100</option><option :value="500">500</option><option :value="1000">1000</option>
        </select>
      </label>
      <label class="block">
        <span class="font-medium">Filtre</span>
        <input v-model="filter" placeholder="texte à rechercher" class="mt-1 block rounded border border-slate-300 px-3 py-2" />
      </label>
      <button v-if="status !== 'live' && status !== 'connecting'" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700" @click="start">Suivre les logs</button>
      <button v-else class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="stop">Arrêter</button>
      <label class="flex items-center gap-1"><input v-model="follow" type="checkbox" /> Défilement automatique</label>
      <span class="text-xs text-slate-500" aria-live="polite">
        {{ status === "live" ? "● en direct" : status === "connecting" ? "connexion…" : message }}
      </span>
    </div>
    <pre ref="box" class="h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded bg-[#0b1220] p-3 font-mono text-xs leading-5 text-[#e2e8f0]" tabindex="0" aria-label="Logs">{{ shown.join("\n") || (status === "idle" ? "Cliquez sur « Suivre les logs »." : "") }}</pre>
    <p class="text-xs text-slate-500">
      {{ shown.length }} ligne(s) affichée(s) sur {{ lines.length }} (5 000 maximum conservées). Le flux est borné en durée et en débit ; les valeurs affichées sont celles des conteneurs, non masquées.
    </p>
  </div>
</template>
