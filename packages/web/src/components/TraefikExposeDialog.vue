<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { api, describeError, type ChangeResult } from "../api";
import DiffView from "./DiffView.vue";

// Exposition d'un service par Traefik : domaines, port et middlewares, aperçu du diff Compose, puis enregistrement
// d'une révision (non déployée). Le retrait de l'exposition passe par le même aperçu.
export interface TraefikService {
  service: string;
  routerName: string;
  exposure: { hosts: string[]; port: number; middlewares: string[] } | null;
  customRule: boolean;
  ports: number[];
}
export interface TraefikSettingsView { httpsEntryPoint: string; certResolver: string; network: string }

const props = defineProps<{ stackId: string; revision: number; item: TraefikService; settings: TraefikSettingsView }>();
const emit = defineEmits<{ close: []; saved: [revision: number, removed: boolean] }>();

const form = reactive({
  hosts: (props.item.exposure?.hosts ?? []).join("\n"),
  port: props.item.exposure?.port || props.item.ports[0] || 80,
  middlewares: (props.item.exposure?.middlewares ?? []).join(", "),
});
const step = ref<"form" | "diff">("form");
const removing = ref(false);
const before = ref("");
const after = ref("");
const message = ref("");
const error = ref("");
const busy = ref(false);

const input = "rounded border border-slate-300 px-3 py-2";
const hostList = computed(() => form.hosts.split(/[\s,;]+/).map((h) => h.trim()).filter(Boolean));
const middlewareList = computed(() => form.middlewares.split(/[\s,;]+/).map((m) => m.trim()).filter(Boolean));
const exposed = computed(() => props.item.exposure !== null);
const url = () => `/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.item.service)}/traefik`;
const payload = () =>
  removing.value
    ? { expectedRevision: props.revision, expose: false }
    : { expectedRevision: props.revision, expose: true, hosts: hostList.value, port: Number(form.port), middlewares: middlewareList.value };

async function preview(remove: boolean) {
  error.value = "";
  removing.value = remove;
  busy.value = true;
  try {
    const r = await api<{ before: string; after: string }>(`${url()}/preview`, { method: "POST", body: JSON.stringify(payload()) });
    before.value = r.before;
    after.value = r.after;
    step.value = "diff";
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function save() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<ChangeResult>(url(), { method: "PATCH", body: JSON.stringify({ ...payload(), ...(message.value ? { message: message.value } : {}) }) });
    emit("saved", r.revision, removing.value);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// Middlewares définis dans la configuration dynamique de Traefik, proposés sous la forme « nom@file ».
const known = ref<string[]>([]);
function toggleMiddleware(name: string) {
  const current = middlewareList.value;
  form.middlewares = (current.includes(name) ? current.filter((m) => m !== name) : [...current, name]).join(", ");
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(async () => {
  document.addEventListener("keydown", onKey);
  try {
    const r = await api<{ available: boolean; middlewares?: { name: string }[] }>("/api/v1/settings/traefik/dynamic");
    known.value = r.available ? (r.middlewares ?? []).map((m) => `${m.name}@file`) : [];
  } catch {
    /* suggestions facultatives : la saisie libre reste possible */
  }
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`Exposition de ${item.service} par Traefik`" class="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">{{ removing ? "Retirer" : exposed ? "Modifier l'exposition de" : "Exposer" }} « {{ item.service }} » par Traefik</h2>
          <p class="text-xs text-slate-500">{{ step === "form" ? "1/2 Configuration" : "2/2 Différences du Compose" }}</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div v-if="step === 'form'" class="space-y-4 p-6 text-sm">
        <p v-if="item.customRule" role="note" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          La règle de ce routeur contient autre chose que des noms de domaine (chemin, en-tête…). L'enregistrer la remplace par la liste de domaines ci-dessous.
        </p>

        <label class="block">
          <span class="mb-1 block font-medium">Noms de domaine</span>
          <textarea v-model="form.hosts" rows="2" placeholder="blog.exemple.fr" aria-label="Noms de domaine" :class="[input, 'w-full font-mono text-xs']"></textarea>
          <span class="mt-1 block text-xs text-slate-500">Un par ligne (5 au plus). Chaque domaine doit pointer vers le serveur de Traefik ; le certificat est demandé automatiquement.</span>
        </label>

        <label class="block">
          <span class="mb-1 block font-medium">Port dans le conteneur</span>
          <input v-model.number="form.port" type="number" min="1" max="65535" list="traefik-ports" :class="[input, 'w-32']" />
          <datalist id="traefik-ports"><option v-for="p in item.ports" :key="p" :value="p"></option></datalist>
          <span class="mt-1 block text-xs text-slate-500">
            Le port sur lequel le service écoute à l'intérieur du conteneur (pas un port publié sur l'hôte).
            <template v-if="item.ports.length">Ports exposés par l'image : {{ item.ports.join(", ") }}.</template>
          </span>
        </label>

        <label class="block">
          <span class="mb-1 block font-medium">Middlewares (facultatif)</span>
          <input v-model="form.middlewares" placeholder="auth@file, securite@file" aria-label="Middlewares" :class="[input, 'w-full font-mono text-xs']" />
          <span v-if="known.length" class="mt-2 flex flex-wrap items-center gap-1" aria-label="Middlewares disponibles">
            <span class="text-xs text-slate-500">Disponibles :</span>
            <button
              v-for="m in known"
              :key="m"
              type="button"
              :aria-pressed="middlewareList.includes(m)"
              :class="['rounded border px-2 py-0.5 font-mono text-xs', middlewareList.includes(m) ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-300 hover:bg-slate-100']"
              @click="toggleMiddleware(m)"
            >
              {{ m }}
            </button>
          </span>
          <span class="mt-1 block text-xs text-slate-500">
            Noms séparés par des virgules, tels que Traefik les connaît (par exemple <code>auth@file</code>). Ils doivent exister dans la configuration de Traefik :
            <template v-if="!known.length">créez-les dans Paramètres → Traefik → Configuration dynamique.</template>
          </span>
        </label>

        <dl class="grid gap-x-6 gap-y-1 rounded bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2">
          <div><dt class="inline text-slate-500">Entrypoint :</dt> <dd class="inline font-mono">{{ settings.httpsEntryPoint }}</dd></div>
          <div><dt class="inline text-slate-500">Résolveur :</dt> <dd class="inline font-mono">{{ settings.certResolver }}</dd></div>
          <div class="sm:col-span-2"><dt class="inline text-slate-500">Réseau partagé :</dt> <dd class="inline font-mono">{{ settings.network }}</dd> — le service y est rattaché (en gardant le réseau de son projet).</div>
        </dl>
        <p class="text-xs text-slate-500">Les autres labels du service sont conservés. Le routeur s'appelle <code>{{ item.routerName }}</code>.</p>
      </div>

      <div v-else class="space-y-3 p-6 text-sm">
        <DiffView :before="before" :after="after" />
        <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" :class="[input, 'w-full']" />
        <p class="text-xs text-slate-500">
          Une nouvelle révision sera enregistrée ; elle n'est pas déployée automatiquement.
          <template v-if="removing">Le service reste rattaché au réseau de Traefik.</template>
        </p>
      </div>

      <p v-if="error" role="alert" class="px-6 pb-2 text-sm text-red-700">{{ error }}</p>

      <footer class="flex flex-wrap justify-between gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <div>
          <button v-if="step === 'form' && exposed" class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50" :disabled="busy" @click="preview(true)">Retirer l'exposition</button>
        </div>
        <div class="flex gap-3">
          <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="step === 'diff' ? (step = 'form') : emit('close')">{{ step === "diff" ? "Retour" : "Annuler" }}</button>
          <button v-if="step === 'form'" :disabled="busy || hostList.length === 0" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="preview(false)">Voir les différences</button>
          <button v-else :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
        </div>
      </footer>
    </div>
  </div>
</template>
