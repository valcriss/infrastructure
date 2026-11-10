<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { api, describeError, fmtDate } from "../../api";
import CastPlayer from "../../components/CastPlayer.vue";
import PanelCard from "../../components/PanelCard.vue";

// Réglages du terminal de conteneur (administrateurs) et rejeu des sessions enregistrées.
interface Settings { enabled: boolean; idleMinutes: number; maxMinutes: number; record: boolean; requireSecondFactor: boolean }
interface Recording {
  id: string;
  userEmail: string;
  hostName: string;
  containerName: string;
  project: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  exitCode: number | null;
  recordingBytes: number;
  truncated: boolean;
  recorded: boolean;
  active: boolean;
}

const form = reactive<Settings>({ enabled: false, idleMinutes: 10, maxMinutes: 60, record: true, requireSecondFactor: true });
const sessions = ref<Recording[]>([]);
const error = ref("");
const ok = ref("");
const cast = ref<{ id: string; text: string } | null>(null);
let timer: number | undefined;
const input = "mt-1 w-28 rounded border border-slate-300 px-3 py-2 text-sm";
const ghost = "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50";

async function loadSettings() {
  Object.assign(form, await api<Settings>("/api/v1/settings/terminal"));
}
async function loadSessions() {
  try {
    sessions.value = (await api<{ sessions: Recording[] }>("/api/v1/terminal-recordings")).sessions;
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(() => {
  void loadSettings();
  void loadSessions();
  timer = window.setInterval(() => void loadSessions(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

async function save() {
  error.value = ok.value = "";
  try {
    Object.assign(form, await api<Settings>("/api/v1/settings/terminal", { method: "PUT", body: JSON.stringify({ ...form }) }));
    ok.value = "Réglages enregistrés.";
  } catch (err) {
    error.value = describeError(err);
  }
}

async function replay(r: Recording) {
  error.value = "";
  try {
    const res = await fetch(`/api/v1/terminal-recordings/${r.id}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    cast.value = { id: r.id, text: await res.text() };
  } catch (err) {
    error.value = describeError(err);
  }
}

async function remove(r: Recording) {
  if (!window.confirm("Supprimer définitivement cet enregistrement ?")) return;
  try {
    await api(`/api/v1/terminal-recordings/${r.id}`, { method: "DELETE" });
    if (cast.value?.id === r.id) cast.value = null;
    await loadSessions();
  } catch (err) {
    error.value = describeError(err);
  }
}

const duration = (r: Recording): string => {
  if (!r.endedAt) return "en cours";
  const s = Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
const size = (b: number): string => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} Mio` : `${Math.max(1, Math.round(b / 1024))} Kio`);
</script>

<template>
  <div class="space-y-4">
    <PanelCard title="Terminal de conteneur" icon="terminal" subtitle="Désactivé par défaut. L'utilisateur doit avoir le droit Terminal et, sauf réglage contraire, un deuxième facteur récent (moins de 10 minutes).">
      <form class="flex flex-wrap items-end gap-4 text-sm" @submit.prevent="save">
        <label class="flex items-center gap-2 pb-2"><input v-model="form.enabled" type="checkbox" /> Activer le terminal</label>
        <label><span class="block font-medium">Inactivité (min)</span><input v-model.number="form.idleMinutes" type="number" min="1" max="240" :class="input" /></label>
        <label><span class="block font-medium">Durée maximale (min)</span><input v-model.number="form.maxMinutes" type="number" min="1" max="480" :class="input" /></label>
        <label class="flex items-center gap-2 pb-2"><input v-model="form.record" type="checkbox" /> Enregistrer les sessions</label>
        <label class="flex items-center gap-2 pb-2"><input v-model="form.requireSecondFactor" type="checkbox" /> Exiger un deuxième facteur</label>
        <button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">Enregistrer</button>
      </form>
      <p v-if="!form.requireSecondFactor" role="note" class="mt-2 text-sm text-amber-700">
        Attention : sans deuxième facteur, une session volée suffit pour obtenir un shell dans les conteneurs. Le droit Terminal reste obligatoire et les sessions restent journalisées.
      </p>
      <p v-if="ok" role="status" class="mt-2 text-sm text-green-700">{{ ok }}</p>
      <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
      <p class="mt-3 text-xs text-slate-500">
        Les enregistrements contiennent ce qui s'affiche à l'écran, donc d'éventuels secrets : ils ne sont visibles que par les administrateurs et ne sont pas inclus dans la sauvegarde Git.
        Les saisies sans écho (mots de passe) ne sont pas enregistrées. Les terminaux sont refusés dans les conteneurs de la console et de l'agent.
      </p>
    </PanelCard>

    <PanelCard title="Sessions" icon="clock-rotate-left" subtitle="200 dernières sessions">
      <p v-if="sessions.length === 0" class="text-sm text-slate-500">Aucune session.</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-slate-500"><tr><th class="py-1 pr-3">Début</th><th class="px-3 py-1">Utilisateur</th><th class="px-3 py-1">Conteneur</th><th class="px-3 py-1">Durée</th><th class="px-3 py-1">Fin</th><th class="px-3 py-1">Actions</th></tr></thead>
          <tbody>
            <tr v-for="r in sessions" :key="r.id" class="border-t border-slate-100">
              <td class="py-2 pr-3 text-xs">{{ fmtDate(r.startedAt) }}</td>
              <td class="px-3 py-2">{{ r.userEmail }}</td>
              <td class="px-3 py-2">{{ r.containerName }}<span class="block text-xs text-slate-500">{{ r.hostName }}<template v-if="r.project"> · {{ r.project }}</template></span></td>
              <td class="px-3 py-2 text-xs">{{ duration(r) }}</td>
              <td class="px-3 py-2 text-xs text-slate-600">{{ r.active ? "ouverte" : (r.endReason ?? "—") }}<template v-if="r.exitCode !== null"> (code {{ r.exitCode }})</template></td>
              <td class="px-3 py-2">
                <span class="flex gap-1">
                  <button :class="ghost" :disabled="!r.recorded" :title="r.recorded ? `${size(r.recordingBytes)}${r.truncated ? ' · tronqué' : ''}` : 'Session non enregistrée'" @click="replay(r)">Rejouer</button>
                  <button :class="ghost" :disabled="r.active" @click="remove(r)">Supprimer</button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </PanelCard>

    <PanelCard v-if="cast" title="Rejeu" icon="play" subtitle="Sortie écran de la session ; les pauses sont abrégées">
      <template #actions><button :class="ghost" @click="cast = null">Fermer</button></template>
      <CastPlayer :key="cast.id" :cast="cast.text" />
    </PanelCard>
  </div>
</template>
