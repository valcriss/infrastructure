<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, describeError, fmtDate } from "../api";
import { useSession } from "../stores/session";
import PanelCard from "./PanelCard.vue";

// Préparation planifiée des correctifs d'images : désactivée par défaut, jamais de déploiement ni d'application automatique.
interface AutoState {
  settings: { enabled: boolean; maxPerDay: number; excluded: string[] };
  usedToday: number;
  pausedUntil: string | null;
  lastPassAt: string | null;
  lastPassStarted: number;
}

const session = useSession();
const state = ref<AutoState | null>(null);
const form = reactive({ enabled: false, maxPerDay: 3, excluded: "" });
const error = ref("");
const info = ref("");
const busy = ref(false);
const canEdit = computed(() => session.isAdmin);

function fill(s: AutoState) {
  state.value = s;
  form.enabled = s.settings.enabled;
  form.maxPerDay = s.settings.maxPerDay;
  form.excluded = s.settings.excluded.join("\n");
}
async function load() {
  try {
    fill(await api<AutoState>("/api/v1/settings/remediation"));
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(load);

async function save() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const excluded = form.excluded.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    fill(await api<AutoState>("/api/v1/settings/remediation", { method: "PUT", body: JSON.stringify({ enabled: form.enabled, maxPerDay: Number(form.maxPerDay), excluded }) }));
    info.value = "Réglages enregistrés.";
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
async function runNow() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await api<{ started: number; skipped: string | null; state: AutoState }>("/api/v1/settings/remediation/run", { method: "POST" });
    fill(r.state);
    const why = { disabled: "la préparation est désactivée", paused: "la préparation est en pause après des échecs", daily_limit: "le plafond des 24 h est atteint" } as const;
    info.value = r.skipped ? `Rien n'a été lancé : ${why[r.skipped as keyof typeof why] ?? r.skipped}.` : `${r.started} correctif(s) lancé(s).`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PanelCard title="Correctifs d'images automatiques" icon="shield-halved" subtitle="Préparation planifiée, sans jamais appliquer ni déployer">
    <p class="text-sm text-slate-600">
      Quand une image utilisée par une application gérée devient corrigeable, la console peut <strong>préparer</strong> un correctif (copie dans le registre privé, correctif des paquets du système, nouveau scan). Le résultat est signalé « à relire » sur la page Images : il n'est <strong>jamais</strong> appliqué à une application ni déployé tout seul.
      Une image n'est préparée qu'une fois par contenu, dans la limite du plafond par 24 h ; trois échecs consécutifs suspendent la préparation pendant 24 h.
    </p>
    <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="mt-2 text-sm text-green-700">{{ info }}</p>

    <form v-if="state" class="mt-4 space-y-3 text-sm" @submit.prevent="save">
      <label class="flex items-center gap-2"><input v-model="form.enabled" type="checkbox" :disabled="!canEdit" /> Préparer automatiquement les correctifs (désactivé par défaut)</label>
      <label class="block">
        <span class="font-medium">Plafond par 24 h</span>
        <input v-model.number="form.maxPerDay" type="number" min="1" max="20" :disabled="!canEdit" class="mt-1 w-28 rounded border border-slate-300 px-3 py-2" />
      </label>
      <label class="block">
        <span class="font-medium">Images exclues</span>
        <textarea v-model="form.excluded" rows="3" :disabled="!canEdit" placeholder="postgres&#10;ghcr.io/org/app" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"></textarea>
        <span class="text-xs text-slate-500">Une image par ligne, sans étiquette : elles ne sont jamais préparées automatiquement (un correctif manuel reste possible).</span>
      </label>
      <p class="text-xs text-slate-600">
        Aujourd'hui : {{ state.usedToday }} / {{ state.settings.maxPerDay }} correctif(s) automatique(s) sur 24 h
        <template v-if="state.lastPassAt"> · dernier passage {{ fmtDate(state.lastPassAt) }} ({{ state.lastPassStarted }} lancé(s))</template>
      </p>
      <p v-if="state.pausedUntil" role="note" class="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
        En pause jusqu'au {{ fmtDate(state.pausedUntil) }} : trois correctifs automatiques de suite ont échoué. Consultez-les dans l'historique de la page Images.
      </p>
      <div v-if="canEdit" class="flex flex-wrap gap-2">
        <button class="rounded-md bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy">Enregistrer</button>
        <button type="button" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" :disabled="busy || !state.settings.enabled" @click="runNow">Lancer un passage maintenant</button>
      </div>
      <p v-else class="text-xs text-slate-500">Seul un administrateur peut modifier ces réglages.</p>
    </form>
  </PanelCard>
</template>
