<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, api, type Host, type HostDetail } from "../api";

const hosts = ref<Host[]>([]);
const loading = ref(true);
const error = ref("");
const selected = ref<HostDetail | null>(null);
const newToken = ref<{ token: string; expiresAt: string } | null>(null);
let timer: number | undefined;

async function load() {
  try {
    hosts.value = (await api<{ hosts: Host[] }>("/api/v1/hosts")).hosts;
    if (selected.value) await select(selected.value.id);
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Chargement impossible.";
  } finally {
    loading.value = false;
  }
}

async function select(id: string) {
  selected.value = await api<HostDetail>(`/api/v1/hosts/${id}`);
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

const byProject = computed(() => {
  const groups = new Map<string, HostDetail["containers"]>();
  for (const c of selected.value?.containers ?? []) {
    const key = c.composeProject ?? "(hors Compose)";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
});

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR") : "jamais");

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-8">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">Hôtes</h1>
      <button class="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700" @click="createToken">
        Enrôler un hôte
      </button>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>

    <section v-if="newToken" class="rounded border border-amber-300 bg-amber-50 p-4 text-sm">
      <p class="font-medium">Jeton d'enrôlement (affiché une seule fois, valable jusqu'à {{ fmt(newToken.expiresAt) }})</p>
      <code class="mt-2 block break-all rounded bg-white px-2 py-1 font-mono">{{ newToken.token }}</code>
      <p class="mt-2 text-slate-600">
        Lancez le Compose de l'agent sur l'hôte cible avec
        <code>ENROLLMENT_TOKEN</code> et <code>CONSOLE_URL</code> renseignés.
      </p>
      <button class="mt-2 text-slate-600 underline" @click="newToken = null">Fermer</button>
    </section>

    <p v-if="loading" class="text-slate-500">Chargement…</p>
    <p v-else-if="hosts.length === 0" class="text-slate-500">
      Aucun hôte. L'agent local s'enrôle automatiquement au démarrage.
    </p>

    <ul v-else class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
      <li v-for="h in hosts" :key="h.id" class="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div class="flex items-center gap-2">
            <span
              class="inline-block h-2.5 w-2.5 rounded-full"
              :class="h.presence === 'online' ? 'bg-green-500' : 'bg-slate-400'"
              aria-hidden="true"
            ></span>
            <span class="font-medium">{{ h.name }}</span>
            <span class="text-xs text-slate-500">{{ h.presence === "online" ? "en ligne" : "hors ligne (état inconnu)" }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            Dernière communication : {{ fmt(h.lastSeenAt) }} · Docker {{ h.dockerVersion ?? "?" }} ·
            {{ h.containerCount ?? "?" }} conteneurs (observé le {{ fmt(h.inventoryObservedAt) }})
          </p>
        </div>
        <div class="flex gap-2 text-sm">
          <button class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="select(h.id)">Conteneurs</button>
          <button class="rounded border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50" @click="revoke(h)">Révoquer</button>
        </div>
      </li>
    </ul>

    <section v-if="selected" class="space-y-4">
      <h2 class="text-lg font-semibold">Conteneurs de {{ selected.name }}</h2>
      <p v-if="selected.presence !== 'online'" class="text-sm text-amber-700">
        Hôte hors ligne : ces états sont ceux de la dernière observation ({{ fmt(selected.inventoryObservedAt) }}).
      </p>
      <div v-for="[project, list] in byProject" :key="project" class="rounded-lg border border-slate-200 bg-white">
        <h3 class="border-b border-slate-200 px-4 py-2 text-sm font-medium">{{ project }}</h3>
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-slate-500">
            <tr><th class="px-4 py-1">Nom</th><th class="px-4 py-1">Image</th><th class="px-4 py-1">État</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in list" :key="c.id" class="border-t border-slate-100">
              <td class="px-4 py-2">{{ c.composeService ?? c.names[0] }}</td>
              <td class="px-4 py-2 font-mono text-xs">{{ c.image }}</td>
              <td class="px-4 py-2">{{ c.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
