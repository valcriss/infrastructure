<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api, describeError } from "../api";

// Boîte de dialogue « Scanner tout » : choix du périmètre, décompte en direct, puis mise en file (un scan à la fois).
const emit = defineEmits<{ close: []; started: [result: BatchResult] }>();

export interface BatchResult {
  dryRun: boolean;
  total: number;
  requested: number;
  alreadyQueued: number;
  skippedOffline: number;
}

const form = reactive({ scope: "never" as "never" | "outdated" | "all", managedOnly: false });
const count = ref<BatchResult | null>(null);
const counting = ref(false);
const busy = ref(false);
const error = ref("");
const dialog = ref<HTMLElement | null>(null);
let debounce: number | undefined;
let seq = 0;

const SCOPES = [
  { value: "never", label: "Images jamais scannées", help: "Aucun scan réussi pour le moment (un scan en échec compte comme non scanné)." },
  { value: "outdated", label: "Jamais scannées ou périmées", help: "Ajoute celles dont le dernier scan est ancien : la base de vulnérabilités a évolué depuis." },
  { value: "all", label: "Toutes les images", help: "Relance aussi les images déjà scannées récemment." },
] as const;

async function recount() {
  const mine = ++seq;
  counting.value = true;
  try {
    const r = await api<BatchResult>("/api/v1/images/scans", { method: "POST", body: JSON.stringify({ ...form, dryRun: true }) });
    if (mine === seq) {
      count.value = r;
      error.value = "";
    }
  } catch (err) {
    if (mine === seq) error.value = describeError(err);
  } finally {
    if (mine === seq) counting.value = false;
  }
}

watch(form, () => {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void recount(), 250);
});

async function start() {
  busy.value = true;
  error.value = "";
  try {
    emit("started", await api<BatchResult>("/api/v1/images/scans", { method: "POST", body: JSON.stringify({ ...form, dryRun: false }) }));
  } catch (err) {
    error.value = describeError(err);
    busy.value = false;
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && !busy.value) emit("close");
};
onMounted(async () => {
  document.addEventListener("keydown", onKey);
  await nextTick();
  dialog.value?.focus();
  void recount();
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  window.clearTimeout(debounce);
});

/** Ordre de grandeur : de quelques secondes à une minute par image, la base étant téléchargée au premier scan. */
const estimate = (n: number): string => (n === 0 ? "" : n < 3 ? "quelques minutes" : `environ ${Math.round((n * 30) / 60)} à ${Math.max(2, Math.round(n))} minutes`);
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div ref="dialog" role="dialog" aria-modal="true" aria-label="Scanner les images" tabindex="-1" class="w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-2xl outline-none">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <h2 class="flex items-center gap-2 text-lg font-semibold"><FaIcon :icon="['fas', 'shield-halved']" class="text-blue-600" /> Scanner les images</h2>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div class="space-y-5 p-6">
        <fieldset>
          <legend class="text-sm font-semibold">Quelles images ?</legend>
          <label v-for="s in SCOPES" :key="s.value" class="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-3 text-sm has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50/50">
            <input v-model="form.scope" type="radio" :value="s.value" class="mt-1" />
            <span><span class="font-medium">{{ s.label }}</span><span class="block text-xs text-slate-500">{{ s.help }}</span></span>
          </label>
        </fieldset>

        <label class="flex items-start gap-2 text-sm">
          <input v-model="form.managedOnly" type="checkbox" class="mt-1" />
          <span>Seulement les images des applications gérées par la console<span class="block text-xs text-slate-500">Sinon, les images des applications observées et des conteneurs hors application sont incluses.</span></span>
        </label>

        <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm" aria-live="polite">
          <template v-if="count">
            <p class="text-2xl font-semibold tabular-nums">{{ count.requested }} <span class="text-base font-normal text-slate-500">image(s) seront mises en file</span></p>
            <p v-if="count.requested" class="mt-1 text-xs text-slate-500">Les scans s'exécutent <strong>un à la fois</strong>, dans l'ordre : {{ estimate(count.requested) }} au total. Les autres restent « en attente ».</p>
            <p v-if="count.alreadyQueued" class="mt-1 text-xs text-slate-500">{{ count.alreadyQueued }} déjà en file ou en cours : non relancée(s).</p>
            <p v-if="count.skippedOffline" class="mt-1 text-xs text-amber-700">{{ count.skippedOffline }} ignorée(s) : aucun hôte en ligne ne porte ces images.</p>
          </template>
          <p v-else class="text-slate-500">{{ counting ? "Décompte…" : "—" }}</p>
        </div>
        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      </div>

      <footer class="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
        <button class="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100" :disabled="busy" @click="emit('close')">Annuler</button>
        <button class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" :disabled="busy || !count || count.requested === 0" @click="start">
          <FaIcon :icon="['fas', 'shield-halved']" /> Lancer {{ count?.requested ?? 0 }} scan(s)
        </button>
      </footer>
    </div>
  </div>
</template>
