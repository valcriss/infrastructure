<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, describeError, type CandidateView, type TagSuggestions } from "../api";
import { useSession } from "../stores/session";
import DiffView from "./DiffView.vue";
import SeverityBadges from "./SeverityBadges.vue";

// Compare les vulnérabilités d'une autre version de l'image avant de l'adopter : l'image est téléchargée sur
// l'hôte, scannée puis retirée. Rien n'est déployé.
const props = defineProps<{ stackId: string; service: string; refreshKey?: string | null }>();
const emit = defineEmits<{ changed: [] }>();
const session = useSession();

const suggestions = ref<TagSuggestions | null>(null);
const candidates = ref<CandidateView[]>([]);
const tag = ref("");
const error = ref("");
const busy = ref(false);
const revision = ref(0);
const adoptUrl = (): string => `/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/image-tag`;
let timer: number | undefined;

const mine = computed(() => candidates.value.filter((c) => c.service === props.service));
const running = computed(() => mine.value.some((c) => c.status === "pulling" || c.status === "scanning"));

async function load() {
  try {
    candidates.value = (await api<{ candidates: CandidateView[] }>(`/api/v1/stacks/${props.stackId}/candidate-scans`)).candidates;
  } catch {
    /* réessayé au prochain passage */
  }
}

async function loadSuggestions() {
  try {
    suggestions.value = await api<TagSuggestions>(`/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/tag-suggestions`);
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 4000);
  void loadSuggestions();
});
// Une nouvelle vérification des mises à jour change les versions proposées : on recharge les suggestions.
watch(() => props.refreshKey, () => void loadSuggestions());
onBeforeUnmount(() => window.clearInterval(timer));

async function compare(t: string) {
  const value = t.trim();
  if (!value) return;
  error.value = "";
  busy.value = true;
  try {
    await api(`/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/candidate-scans`, { method: "POST", body: JSON.stringify({ tag: value }) });
    tag.value = "";
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function dismiss(c: CandidateView) {
  error.value = "";
  try {
    await api(`/api/v1/stacks/${props.stackId}/candidate-scans/${c.id}/dismiss`, { method: "POST" });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function dismissAll() {
  if (!window.confirm(`Fermer les ${mine.value.length} comparaisons de « ${props.service} » ? Elles ne seront plus proposées.`)) return;
  error.value = "";
  try {
    await api(`/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/candidate-scans/dismiss`, { method: "POST" });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

const severe = (c: { critical: number; high: number }): number => c.critical + c.high;
const STATUS: Record<CandidateView["status"], string> = { pulling: "téléchargement…", scanning: "scan en cours…", succeeded: "terminé", failed: "échec" };

/** Verdict lisible : mieux, pareil ou pire sur les CVE critiques et élevées. */
function verdict(c: CandidateView): { text: string; cls: string } | null {
  if (!c.result || !c.current) return null;
  const a = severe(c.current.counts);
  const b = severe(c.result.counts);
  if (b < a) return { text: `${a - b} CVE critique(s)/élevée(s) de moins (${a} → ${b})`, cls: "text-green-700" };
  if (b > a) return { text: `${b - a} CVE critique(s)/élevée(s) de plus (${a} → ${b})`, cls: "text-red-700" };
  return { text: `Autant de CVE critiques/élevées (${a})`, cls: "text-slate-600" };
}

// --- Adopter la version comparée : aperçu du changement dans le Compose, puis une révision (sans déploiement) ---
const adopt = ref<{ tag: string; before: string; after: string; from: string; to: string; file?: string | null } | null>(null);
const adoptMessage = ref("");
const adoptError = ref("");
const adoptBusy = ref(false);
const adoptDone = ref("");

async function startAdopt(c: CandidateView) {
  adoptError.value = adoptDone.value = "";
  adoptBusy.value = true;
  try {
    const stack = await api<{ currentRevision: number }>(`/api/v1/stacks/${props.stackId}`);
    revision.value = stack.currentRevision;
    const r = await api<{ before: string; after: string; from: string; to: string; file?: string | null }>(`${adoptUrl()}/preview`, { method: "POST", body: JSON.stringify({ expectedRevision: revision.value, tag: c.tag }) });
    adopt.value = { tag: c.tag, ...r };
    adoptMessage.value = "";
  } catch (err) {
    error.value = describeError(err);
  } finally {
    adoptBusy.value = false;
  }
}

async function confirmAdopt() {
  if (!adopt.value) return;
  adoptBusy.value = true;
  adoptError.value = "";
  try {
    const r = await api<{ revision: number }>(adoptUrl(), { method: "PATCH", body: JSON.stringify({ expectedRevision: revision.value, tag: adopt.value.tag, ...(adoptMessage.value ? { message: adoptMessage.value } : {}) }) });
    adoptDone.value = `Révision ${r.revision} enregistrée avec ${adopt.value.to}. Elle n'est pas déployée : utilisez « Déployer » dans la vue d'ensemble.`;
    adopt.value = null;
    emit("changed");
  } catch (err) {
    adoptError.value = describeError(err);
  } finally {
    adoptBusy.value = false;
  }
}

const newer = computed(() => suggestions.value?.newer ?? []);
const variants = computed(() => suggestions.value?.variants ?? []);
/** Les suggestions sont chargées, sans erreur de lecture du registre, et aucune version plus récente n'a été trouvée. */
const noneNewer = computed(() => suggestions.value !== null && suggestions.value.current !== null && newer.value.length === 0 && suggestions.value.listed !== false);
</script>

<template>
  <section class="space-y-3 border-t border-slate-100 pt-3 text-sm" aria-label="Comparer une autre version">
    <h3 class="font-medium">Comparer une autre version</h3>
    <p class="text-xs text-slate-500">
      Télécharge l'image sur l'hôte, la scanne puis la retire : rien n'est déployé. Pour adopter une version, modifiez le tag dans Configuration → Compose, puis déployez.
    </p>
    <div v-if="newer.length" class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-slate-700">Plus récentes :</span>
      <button v-for="t in newer" :key="t" :disabled="!session.canOperate || busy" class="rounded-full border border-blue-300 bg-blue-50 px-2.5 py-0.5 font-mono text-xs text-blue-800 hover:bg-blue-100 disabled:opacity-50" title="Version plus récente" @click="compare(t)">{{ t }}</button>
      <button :disabled="!session.canOperate || busy" class="rounded border border-blue-600 bg-blue-600 px-2.5 py-0.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50" @click="compare(newer[0] as string)">Comparer la plus récente ({{ newer[0] }})</button>
    </div>
    <p v-else-if="noneNewer" class="text-xs text-slate-500">Aucune version plus récente trouvée pour la règle de suivi de ce service.</p>
    <div v-if="variants.length" class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-slate-500">Variantes légères :</span>
      <button v-for="t in variants" :key="t" :disabled="!session.canOperate || busy" class="rounded-full border border-slate-300 px-2.5 py-0.5 font-mono text-xs hover:bg-slate-100 disabled:opacity-50" title="Variante légère" @click="compare(t)">{{ t }}</button>
    </div>
    <p v-if="suggestions?.note" class="text-xs text-slate-500">{{ suggestions.note }}</p>
    <form class="flex flex-wrap items-end gap-2" @submit.prevent="compare(tag)">
      <label class="text-xs">
        <span class="block font-medium">Étiquette à comparer</span>
        <input v-model="tag" :disabled="!session.canOperate" placeholder="ex. 5.130-alpine" class="mt-1 rounded border border-slate-300 px-2 py-1.5 font-mono text-sm" />
      </label>
      <button :disabled="!session.canOperate || busy || !tag.trim()" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50">Comparer</button>
      <span v-if="running" class="text-xs text-blue-700" aria-live="polite">Comparaison en cours…</span>
    </form>
    <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>
    <p v-if="adoptDone" role="status" class="text-green-700">{{ adoptDone }}</p>

    <p v-if="mine.length > 1 && session.canOperate" class="text-right text-xs"><button class="underline" @click="dismissAll">Tout fermer ({{ mine.length }})</button></p>
    <ul v-if="mine.length" class="space-y-2">
      <li v-for="c in mine" :key="c.id" class="rounded border border-slate-200 p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono text-xs font-semibold">{{ c.tag }}</span>
          <span class="flex items-center gap-2">
            <span class="text-xs" :class="c.status === 'failed' ? 'text-red-700' : 'text-slate-500'">{{ STATUS[c.status] }}</span>
            <button v-if="session.canOperate" class="rounded p-1 text-slate-500 hover:bg-slate-100" :aria-label="'Fermer la comparaison ' + c.tag" title="Fermer : ne plus proposer cette comparaison" @click="dismiss(c)"><FaIcon :icon="['fas', 'xmark']" /></button>
          </span>
        </div>
        <p v-if="c.error" class="mt-1 text-xs text-red-700">{{ c.error }}</p>
        <div v-if="c.result" class="mt-2 space-y-1 text-xs">
          <p class="flex flex-wrap items-center gap-2">
            <span class="w-20 text-slate-500">Cette version</span>
            <SeverityBadges :state="c.result.total ? 'vulnerable' : 'clean'" :counts="c.result.counts" />
            <span class="text-slate-500">dont {{ c.result.fixable }} avec correctif</span>
          </p>
          <p v-if="c.current" class="flex flex-wrap items-center gap-2">
            <span class="w-20 text-slate-500">Actuelle</span>
            <SeverityBadges :state="c.current.total ? 'vulnerable' : 'clean'" :counts="c.current.counts" />
            <span class="text-slate-500">dont {{ c.current.fixable }} avec correctif</span>
          </p>
          <p v-if="verdict(c)" class="font-medium" :class="verdict(c)!.cls">{{ verdict(c)!.text }}</p>
          <p v-if="c.adopted" class="pt-1 font-medium text-blue-700">Déjà dans la révision enregistrée : il reste à la déployer (vue d'ensemble).</p>
          <p v-else-if="session.canOperate" class="pt-1">
            <button class="rounded border border-blue-300 px-2.5 py-1 text-blue-700 hover:bg-blue-50 disabled:opacity-50" :disabled="adoptBusy" @click="startAdopt(c)">Utiliser cette version…</button>
            <span class="ml-2 text-slate-500">enregistre une révision avec {{ c.tag }} ; rien n'est déployé</span>
          </p>
          <p v-if="c.result.os?.eosl" class="text-amber-700">Le système de cette image ({{ c.result.os.family }} {{ c.result.os.name }}) n'est plus maintenu.</p>
        </div>
      </li>
    </ul>
    <div v-if="adopt" class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="adopt = null">
      <div role="dialog" aria-modal="true" aria-label="Utiliser cette version" class="w-full max-w-2xl space-y-3 rounded-xl border border-slate-200 bg-white p-6 text-sm shadow-2xl">
        <h2 class="text-lg font-semibold">Utiliser {{ adopt.to }}</h2>
        <p class="text-slate-600">
          <template v-if="adopt.file">L'image de base de « {{ service }} » (ligne FROM de <code>{{ adopt.file }}</code>)</template><template v-else>L'image de « {{ service }} »</template>
          passe de <code>{{ adopt.from }}</code> à <code>{{ adopt.to }}</code> dans une nouvelle révision. Rien n'est déployé : vous déployez ensuite, quand vous le décidez.
        </p>
        <DiffView :before="adopt.before" :after="adopt.after" />
        <input v-model="adoptMessage" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" class="w-full rounded border border-slate-300 px-3 py-2" />
        <p v-if="adoptError" role="alert" class="text-red-700">{{ adoptError }}</p>
        <div class="flex justify-end gap-3">
          <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="adopt = null">Annuler</button>
          <button :disabled="adoptBusy" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="confirmAdopt">Enregistrer une révision</button>
        </div>
      </div>
    </div>
  </section>
</template>
