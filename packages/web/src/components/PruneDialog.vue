<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ApiError, api, describeError, formatBytes, type DiskUsageSummary, type Host, type PruneOptions, type PrunePlan, type PruneRun } from "../api";

// Boîte de dialogue de nettoyage d'un hôte : options à gauche, aperçu exact de ce qui sera supprimé à droite.
const props = defineProps<{ host: Host }>();
const emit = defineEmits<{ close: []; done: [] }>();

const PRESETS = [
  { value: 0, label: "Tout" },
  { value: 7, label: "Plus de 7 jours" },
  { value: 30, label: "Plus de 1 mois" },
  { value: 90, label: "Plus de 3 mois" },
  { value: -1, label: "Personnalisé…" },
];

// Réglages par défaut prudents : images sans nom et vieux cache de build ; le reste est à cocher.
const opt = reactive({
  containers: { enabled: false, preset: 0, custom: 14 },
  images: { mode: "dangling" as "off" | "dangling" | "unused", preset: 0, custom: 14 },
  networks: { enabled: false },
  volumes: { mode: "off" as "off" | "anonymous" | "all" },
  buildCache: { enabled: true, preset: 7, custom: 14, keepGB: 0 },
});

const days = (preset: number, custom: number): number | undefined => (preset === 0 ? undefined : preset === -1 ? Math.max(1, Math.round(custom)) : preset);

const options = computed<PruneOptions>(() => ({
  containers: { enabled: opt.containers.enabled, ...(days(opt.containers.preset, opt.containers.custom) ? { olderThanDays: days(opt.containers.preset, opt.containers.custom) } : {}) },
  images: { mode: opt.images.mode, ...(days(opt.images.preset, opt.images.custom) ? { olderThanDays: days(opt.images.preset, opt.images.custom) } : {}) },
  networks: { enabled: opt.networks.enabled },
  volumes: { mode: opt.volumes.mode },
  buildCache: opt.buildCache.enabled
    ? {
        mode: days(opt.buildCache.preset, opt.buildCache.custom) ? "older" : "all",
        ...(days(opt.buildCache.preset, opt.buildCache.custom) ? { olderThanDays: days(opt.buildCache.preset, opt.buildCache.custom) } : {}),
        ...(opt.buildCache.keepGB > 0 ? { keepGB: opt.buildCache.keepGB } : {}),
      }
    : { mode: "off" },
}));

type Step = "loading" | "choose" | "running" | "result";
const step = ref<Step>("loading");
const error = ref("");
const summary = ref<DiskUsageSummary | null>(null);
const plan = ref<PrunePlan | null>(null);
const planning = ref(false);
const confirmName = ref("");
const run = ref<PruneRun | null>(null);
const dialog = ref<HTMLElement | null>(null);
let timer: number | undefined;
let debounce: number | undefined;
let planSeq = 0;

async function refresh() {
  step.value = "loading";
  error.value = "";
  try {
    const r = await api<{ summary: DiskUsageSummary | null }>(`/api/v1/hosts/${props.host.id}/disk-usage/refresh`, { method: "POST" });
    summary.value = r.summary;
    step.value = "choose";
    await preview();
  } catch (err) {
    error.value = describeError(err);
    step.value = "choose";
  }
}

async function preview() {
  const seq = ++planSeq;
  planning.value = true;
  try {
    const p = await api<PrunePlan>(`/api/v1/hosts/${props.host.id}/prune/preview`, { method: "POST", body: JSON.stringify({ options: options.value }) });
    if (seq === planSeq) {
      plan.value = p;
      error.value = "";
    }
  } catch (err) {
    if (seq === planSeq) {
      plan.value = null;
      error.value = describeError(err);
    }
  } finally {
    if (seq === planSeq) planning.value = false;
  }
}

watch(options, () => {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void preview(), 300);
}, { deep: true });

const confirmOk = computed(() => !plan.value?.requiresHostConfirmation || confirmName.value === props.host.name);
const canRun = computed(() => step.value === "choose" && !!plan.value && plan.value.totals.items > 0 && confirmOk.value && !planning.value);

async function start() {
  error.value = "";
  try {
    const r = await api<{ run: PruneRun }>(`/api/v1/hosts/${props.host.id}/prune`, {
      method: "POST",
      body: JSON.stringify({ options: options.value, ...(plan.value?.requiresHostConfirmation ? { confirmHostName: confirmName.value } : {}) }),
    });
    run.value = r.run;
    step.value = "running";
    timer = window.setInterval(() => void poll(), 1500);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : describeError(err);
  }
}

async function poll() {
  if (!run.value) return;
  try {
    run.value = (await api<{ run: PruneRun }>(`/api/v1/prune-runs/${run.value.id}`)).run;
    if (run.value.status !== "running") {
      window.clearInterval(timer);
      step.value = "result";
      emit("done");
    }
  } catch {
    /* nouvelle tentative au prochain passage */
  }
}

function close() {
  if (step.value === "running") return; // un nettoyage lancé se suit jusqu'au bout
  emit("close");
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") close();
};

onMounted(async () => {
  document.addEventListener("keydown", onKey);
  await nextTick();
  dialog.value?.focus();
  void refresh();
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  window.clearInterval(timer);
  window.clearTimeout(debounce);
});

const LEVEL = {
  info: { cls: "border-blue-300 bg-blue-50 text-blue-900", icon: "circle-info" },
  warning: { cls: "border-amber-300 bg-amber-50 text-amber-900", icon: "triangle-exclamation" },
  danger: { cls: "border-red-400 bg-red-50 text-red-900", icon: "triangle-exclamation" },
} as const;

const ageText = (created: number): string => {
  const d = Math.round((Date.now() / 1000 - created) / 86400);
  return d < 1 ? "aujourd'hui" : d < 60 ? `${d} j` : `${Math.round(d / 30)} mois`;
};
const more = (n: number, shown: number): number => Math.max(0, n - shown);
const reclaim = (k: keyof DiskUsageSummary): string => (summary.value ? formatBytes(summary.value[k].reclaimableBytes) : "…");
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="close">
    <div
      ref="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`Nettoyer l'hôte ${host.name}`"
      tabindex="-1"
      class="w-full max-w-6xl rounded-xl border border-slate-200 bg-white shadow-2xl outline-none"
    >
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="flex items-center gap-2 text-lg font-semibold"><FaIcon :icon="['fas', 'broom']" class="text-blue-600" /> Nettoyer « {{ host.name }} »</h2>
          <p class="text-xs text-slate-500">Docker n'a pas de mode simulation : la liste ci-dessous vient d'un relevé de l'agent, juste avant le nettoyage.</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Fermer" :disabled="step === 'running'" @click="close"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div v-if="step === 'loading'" class="flex items-center gap-3 p-10 text-slate-600" role="status">
        <FaIcon :icon="['fas', 'arrows-rotate']" spin /> Relevé de l'espace disque en cours (peut durer quelques secondes)…
      </div>

      <template v-else-if="step === 'choose'">
        <p v-if="error" role="alert" class="mx-6 mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">{{ error }}</p>
        <div class="grid gap-6 p-6 lg:grid-cols-2">
          <div class="space-y-4">
            <fieldset class="rounded-lg border border-slate-200 p-4">
              <legend class="px-2 text-sm font-semibold">Conteneurs arrêtés <span class="font-normal text-slate-500">({{ reclaim("containers") }})</span></legend>
              <label class="flex items-center gap-2 text-sm"><input v-model="opt.containers.enabled" type="checkbox" /> Supprimer les conteneurs arrêtés</label>
              <div v-if="opt.containers.enabled" class="mt-2 flex flex-wrap items-center gap-2 pl-6 text-sm">
                <select v-model.number="opt.containers.preset" aria-label="Ancienneté des conteneurs" class="rounded border border-slate-300 bg-white px-2 py-1">
                  <option v-for="p in PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
                </select>
                <input v-if="opt.containers.preset === -1" v-model.number="opt.containers.custom" type="number" min="1" max="3650" class="w-20 rounded border border-slate-300 px-2 py-1" aria-label="Nombre de jours" /> <span v-if="opt.containers.preset === -1">jours</span>
                <span class="text-xs text-slate-500">(date de création)</span>
              </div>
            </fieldset>

            <fieldset class="rounded-lg border border-slate-200 p-4">
              <legend class="px-2 text-sm font-semibold">Images <span class="font-normal text-slate-500">({{ reclaim("images") }})</span></legend>
              <label class="flex items-center gap-2 text-sm"><input v-model="opt.images.mode" type="radio" value="off" /> Ne pas toucher aux images</label>
              <label class="mt-1 flex items-center gap-2 text-sm"><input v-model="opt.images.mode" type="radio" value="dangling" /> Images sans nom (orphelines)</label>
              <label class="mt-1 flex items-center gap-2 text-sm"><input v-model="opt.images.mode" type="radio" value="unused" /> Toutes les images qu'aucun conteneur n'utilise</label>
              <div v-if="opt.images.mode !== 'off'" class="mt-2 flex flex-wrap items-center gap-2 pl-6 text-sm">
                <select v-model.number="opt.images.preset" aria-label="Ancienneté des images" class="rounded border border-slate-300 bg-white px-2 py-1">
                  <option v-for="p in PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
                </select>
                <input v-if="opt.images.preset === -1" v-model.number="opt.images.custom" type="number" min="1" max="3650" class="w-20 rounded border border-slate-300 px-2 py-1" aria-label="Nombre de jours" /> <span v-if="opt.images.preset === -1">jours</span>
                <span class="text-xs text-slate-500">(date de création)</span>
              </div>
            </fieldset>

            <fieldset class="rounded-lg border border-slate-200 p-4">
              <legend class="px-2 text-sm font-semibold">Réseaux</legend>
              <label class="flex items-center gap-2 text-sm"><input v-model="opt.networks.enabled" type="checkbox" /> Supprimer les réseaux inutilisés</label>
            </fieldset>

            <fieldset class="rounded-lg border border-red-300 p-4">
              <legend class="px-2 text-sm font-semibold text-red-700">Volumes <span class="font-normal">({{ reclaim("volumes") }})</span></legend>
              <label class="flex items-center gap-2 text-sm"><input v-model="opt.volumes.mode" type="radio" value="off" /> Ne pas toucher aux volumes</label>
              <label class="mt-1 flex items-center gap-2 text-sm"><input v-model="opt.volumes.mode" type="radio" value="anonymous" /> Volumes anonymes inutilisés</label>
              <label class="mt-1 flex items-center gap-2 text-sm text-red-700"><input v-model="opt.volumes.mode" type="radio" value="all" /> <strong>Tous</strong> les volumes inutilisés, nommés compris (perte de données)</label>
            </fieldset>

            <fieldset class="rounded-lg border border-slate-200 p-4">
              <legend class="px-2 text-sm font-semibold">Cache de build <span class="font-normal text-slate-500">({{ reclaim("buildCache") }})</span></legend>
              <label class="flex items-center gap-2 text-sm"><input v-model="opt.buildCache.enabled" type="checkbox" /> Vider le cache de build</label>
              <div v-if="opt.buildCache.enabled" class="mt-2 space-y-2 pl-6 text-sm">
                <div class="flex flex-wrap items-center gap-2">
                  <select v-model.number="opt.buildCache.preset" aria-label="Ancienneté du cache de build" class="rounded border border-slate-300 bg-white px-2 py-1">
                    <option v-for="p in PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
                  </select>
                  <input v-if="opt.buildCache.preset === -1" v-model.number="opt.buildCache.custom" type="number" min="1" max="3650" class="w-20 rounded border border-slate-300 px-2 py-1" aria-label="Nombre de jours" /> <span v-if="opt.buildCache.preset === -1">jours</span>
                  <span class="text-xs text-slate-500">(dernière utilisation)</span>
                </div>
                <label class="flex items-center gap-2">Conserver au moins <input v-model.number="opt.buildCache.keepGB" type="number" min="0" step="1" class="w-20 rounded border border-slate-300 px-2 py-1" aria-label="Go à conserver" /> Go</label>
              </div>
            </fieldset>
          </div>

          <div class="space-y-4" aria-live="polite">
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p class="text-sm font-semibold">Ce qui sera supprimé</p>
              <p v-if="!plan" class="mt-1 text-sm text-slate-500">{{ planning ? "Calcul…" : "Aucun aperçu disponible." }}</p>
              <template v-else>
                <p class="mt-1 text-2xl font-semibold tabular-nums">{{ plan.totals.items }} <span class="text-base font-normal text-slate-500">élément(s) · ≈ {{ formatBytes(plan.totals.reclaimableBytes) }} libérés (estimation)</span></p>
                <p v-if="plan.totals.items === 0" class="mt-1 text-sm text-slate-500">Rien à supprimer avec ces options.</p>
              </template>
            </div>

            <ul v-if="plan" class="space-y-2">
              <li v-for="(w, i) in plan.warnings" :key="i" :class="['flex gap-2 rounded-md border p-3 text-sm', LEVEL[w.level].cls]">
                <FaIcon :icon="['fas', LEVEL[w.level].icon]" class="mt-0.5 shrink-0" /> <span>{{ w.text }}</span>
              </li>
            </ul>

            <div v-if="plan" class="max-h-72 space-y-3 overflow-y-auto text-xs">
              <section v-if="plan.items.containers.length">
                <h3 class="font-semibold">Conteneurs ({{ plan.items.containers.length }})</h3>
                <ul class="mt-1 space-y-0.5 font-mono">
                  <li v-for="c in plan.items.containers.slice(0, 25)" :key="c.id" class="flex justify-between gap-2"><span class="truncate">{{ c.name }} <span class="text-slate-400">{{ c.image }}</span></span><span class="shrink-0 text-slate-500">{{ ageText(c.created) }}</span></li>
                </ul>
                <p v-if="more(plan.items.containers.length, 25)" class="text-slate-500">… et {{ more(plan.items.containers.length, 25) }} autre(s)</p>
              </section>
              <section v-if="plan.items.images.length">
                <h3 class="font-semibold">Images ({{ plan.items.images.length }})</h3>
                <ul class="mt-1 space-y-0.5 font-mono">
                  <li v-for="i in plan.items.images.slice(0, 25)" :key="i.id" class="flex justify-between gap-2"><span class="truncate">{{ i.ref }}<span v-if="i.dangling" class="text-slate-400"> (sans nom)</span></span><span class="shrink-0 text-slate-500">{{ formatBytes(i.sizeBytes) }} · {{ ageText(i.created) }}</span></li>
                </ul>
                <p v-if="more(plan.items.images.length, 25)" class="text-slate-500">… et {{ more(plan.items.images.length, 25) }} autre(s)</p>
              </section>
              <section v-if="plan.items.networks.length">
                <h3 class="font-semibold">Réseaux ({{ plan.items.networks.length }})</h3>
                <p class="font-mono">{{ plan.items.networks.map((n) => n.name).join(", ") }}</p>
              </section>
              <section v-if="plan.items.volumes.length">
                <h3 class="font-semibold text-red-700">Volumes ({{ plan.items.volumes.length }})</h3>
                <ul class="mt-1 space-y-0.5 font-mono">
                  <li v-for="v in plan.items.volumes.slice(0, 25)" :key="v.name" class="flex justify-between gap-2"><span class="truncate">{{ v.anonymous ? v.name.slice(0, 12) + "… (anonyme)" : v.name }}<span v-if="v.project" class="text-slate-400"> {{ v.project }}</span></span><span class="shrink-0 text-slate-500">{{ v.sizeBytes === null ? "?" : formatBytes(v.sizeBytes) }}</span></li>
                </ul>
                <p v-if="more(plan.items.volumes.length, 25)" class="text-slate-500">… et {{ more(plan.items.volumes.length, 25) }} autre(s)</p>
              </section>
              <section v-if="plan.items.buildCache.count">
                <h3 class="font-semibold">Cache de build ({{ plan.items.buildCache.count }} entrée(s), {{ formatBytes(plan.items.buildCache.sizeBytes) }})</h3>
              </section>
            </div>

            <div v-if="plan?.requiresHostConfirmation" class="rounded-lg border-2 border-red-400 bg-red-50 p-4 text-sm text-red-900">
              <p class="font-semibold">Confirmation requise : des volumes seront supprimés définitivement.</p>
              <label class="mt-2 block">Saisissez le nom de l'hôte <code class="rounded bg-white px-1">{{ host.name }}</code> pour confirmer
                <input v-model="confirmName" autocomplete="off" class="mt-1 w-full rounded border border-red-300 bg-white px-3 py-2" />
              </label>
            </div>
          </div>
        </div>
        <footer class="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <button class="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100" @click="close">Annuler</button>
          <button class="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40" :disabled="!canRun" @click="start">
            <FaIcon :icon="['fas', 'trash-can']" /> Supprimer {{ plan?.totals.items ?? 0 }} élément(s)
          </button>
        </footer>
      </template>

      <div v-else-if="step === 'running'" class="flex items-center gap-3 p-10 text-slate-600" role="status">
        <FaIcon :icon="['fas', 'arrows-rotate']" spin /> Nettoyage en cours… ne fermez pas cette fenêtre (le suivi se fait jusqu'au bout).
      </div>

      <div v-else-if="step === 'result' && run" class="space-y-4 p-6">
        <p :class="['flex items-center gap-2 text-lg font-semibold', run.status === 'succeeded' && !run.result?.errors.length ? 'text-green-700' : 'text-amber-700']">
          <FaIcon :icon="['fas', run.status === 'succeeded' ? 'circle-check' : 'triangle-exclamation']" />
          {{ run.status === "succeeded" ? "Nettoyage terminé" : run.status === "unknown" ? "Résultat inconnu" : "Nettoyage en échec" }}
        </p>
        <p v-if="run.error" class="rounded-md bg-red-50 p-3 text-sm text-red-800">{{ run.error }}</p>
        <dl v-if="run.result" class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <div class="rounded-lg border border-slate-200 p-3"><dt class="text-xs text-slate-500">Conteneurs</dt><dd class="text-xl font-semibold">{{ run.result.removed.containers }}</dd></div>
          <div class="rounded-lg border border-slate-200 p-3"><dt class="text-xs text-slate-500">Images</dt><dd class="text-xl font-semibold">{{ run.result.removed.images }}</dd></div>
          <div class="rounded-lg border border-slate-200 p-3"><dt class="text-xs text-slate-500">Réseaux</dt><dd class="text-xl font-semibold">{{ run.result.removed.networks }}</dd></div>
          <div class="rounded-lg border border-slate-200 p-3"><dt class="text-xs text-slate-500">Volumes</dt><dd class="text-xl font-semibold">{{ run.result.removed.volumes }}</dd></div>
          <div class="rounded-lg border border-slate-200 p-3"><dt class="text-xs text-slate-500">Cache de build</dt><dd class="text-xl font-semibold">{{ run.result.removed.buildCache }}</dd></div>
        </dl>
        <p v-if="run.result" class="text-sm">Espace libéré : <strong>≈ {{ formatBytes(run.result.reclaimedBytes) }}</strong> <span class="text-slate-500">(estimation d'après la taille des éléments ; valeur mesurée par Docker pour le cache de build)</span></p>
        <section v-if="run.result?.errors.length" class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p class="font-semibold">Erreurs ({{ run.result.errors.length }})</p>
          <ul class="mt-1 list-disc pl-5"><li v-for="(e, i) in run.result.errors" :key="i">{{ e }}</li></ul>
        </section>
        <section v-if="run.result?.skipped.length" class="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm">
          <p class="font-semibold">Ignorés par prudence ({{ run.result.skipped.length }})</p>
          <ul class="mt-1 list-disc pl-5 text-slate-600"><li v-for="(e, i) in run.result.skipped" :key="i">{{ e }}</li></ul>
        </section>
        <div class="flex justify-end"><button class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700" @click="emit('close')">Fermer</button></div>
      </div>
    </div>
  </div>
</template>
