<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ApiError, api, describeError } from "../api";
import DiffView from "./DiffView.vue";

// Middleware ou route de la configuration dynamique de Traefik : formulaire, aperçu du diff de dynamic.yml, puis
// enregistrement d'une révision de l'application Traefik (non déployée). La suppression passe aussi par l'aperçu.
export type MiddlewareSpecView =
  | { type: "ipAllowList"; sourceRange: string[] }
  | { type: "rateLimit"; average: number; burst: number }
  | { type: "headers"; hsts: boolean; frameDeny: boolean; contentTypeNosniff: boolean; referrerPolicy: string }
  | { type: "compress" }
  | { type: "basicAuth"; users: string[] }
  | { type: "stripPrefix"; prefixes: string[] };
export interface MiddlewareItem {
  name: string;
  type: string | null;
  summary: string;
  spec: MiddlewareSpecView | null;
  usedBy: { routes: string[]; applications: string[] };
}
export interface RouteItem {
  name: string;
  hosts: string[];
  urls: string[];
  middlewares: string[];
  summary: string;
  spec: { hosts: string[]; urls: string[]; middlewares: string[] } | null;
}

const props = defineProps<{ mode: "middleware" | "route"; item: MiddlewareItem | RouteItem | null; remove: boolean; revision: number; middlewareNames: string[] }>();
const emit = defineEmits<{ close: []; saved: [revision: number, sensitive: boolean] }>();

const TYPES: { key: MiddlewareSpecView["type"]; label: string; help: string }[] = [
  { key: "ipAllowList", label: "Liste d'adresses autorisées", help: "Seules ces adresses ou plages IP peuvent accéder à la route." },
  { key: "basicAuth", label: "Mot de passe (authentification basique)", help: "Demande un nom et un mot de passe." },
  { key: "headers", label: "En-têtes de sécurité", help: "HSTS, anti-iframe, nosniff, politique de référent." },
  { key: "rateLimit", label: "Limite de débit", help: "Limite le nombre de requêtes par seconde." },
  { key: "compress", label: "Compression", help: "Compresse les réponses (gzip, brotli…)." },
  { key: "stripPrefix", label: "Retirer un préfixe d'URL", help: "Retire un préfixe du chemin avant de transmettre la requête." },
];
const REFERRERS = ["", "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"];

const editing = props.item !== null;
const form = reactive({
  name: props.item?.name ?? "",
  type: ((props.item as MiddlewareItem | null)?.spec?.type ?? "ipAllowList") as MiddlewareSpecView["type"],
  sourceRange: "",
  average: 100,
  burst: 50,
  hsts: true,
  frameDeny: true,
  contentTypeNosniff: true,
  referrerPolicy: "strict-origin-when-cross-origin",
  users: "",
  prefixes: "",
  hosts: "",
  urls: "",
  middlewares: [] as string[],
  extraRefs: "",
});

// Préremplissage depuis l'élément modifié.
const spec = props.item?.spec;
if (props.mode === "middleware" && spec) {
  const s = spec as MiddlewareSpecView;
  if (s.type === "ipAllowList") form.sourceRange = s.sourceRange.join("\n");
  else if (s.type === "rateLimit") Object.assign(form, { average: s.average, burst: s.burst });
  else if (s.type === "headers") Object.assign(form, { hsts: s.hsts, frameDeny: s.frameDeny, contentTypeNosniff: s.contentTypeNosniff, referrerPolicy: s.referrerPolicy });
  else if (s.type === "basicAuth") form.users = s.users.join("\n");
  else if (s.type === "stripPrefix") form.prefixes = s.prefixes.join("\n");
} else if (props.mode === "route" && spec) {
  const s = spec as { hosts: string[]; urls: string[]; middlewares: string[] };
  form.hosts = s.hosts.join("\n");
  form.urls = s.urls.join("\n");
  form.middlewares = s.middlewares.filter((m) => props.middlewareNames.includes(m));
  form.extraRefs = s.middlewares.filter((m) => !props.middlewareNames.includes(m)).join(", ");
}

const step = ref<"form" | "diff">("form");
const before = ref("");
const after = ref("");
const message = ref("");
const error = ref("");
const busy = ref(false);
const inUseApps = ref<string[]>([]);
const force = ref(false);

const input = "rounded border border-slate-300 px-3 py-2";
const list = (s: string): string[] => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const lines = (s: string): string[] => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const typeInfo = computed(() => TYPES.find((t) => t.key === form.type));

function middlewareSpec(): MiddlewareSpecView {
  switch (form.type) {
    case "ipAllowList": return { type: "ipAllowList", sourceRange: list(form.sourceRange) };
    case "rateLimit": return { type: "rateLimit", average: Number(form.average), burst: Number(form.burst) };
    case "headers": return { type: "headers", hsts: form.hsts, frameDeny: form.frameDeny, contentTypeNosniff: form.contentTypeNosniff, referrerPolicy: form.referrerPolicy };
    case "compress": return { type: "compress" };
    case "basicAuth": return { type: "basicAuth", users: lines(form.users) };
    case "stripPrefix": return { type: "stripPrefix", prefixes: list(form.prefixes) };
  }
}
const change = () => {
  const name = form.name.trim();
  if (props.remove) return { kind: props.mode === "middleware" ? "middleware-delete" : "route-delete", name };
  if (props.mode === "middleware") return { kind: "middleware", name, spec: middlewareSpec() };
  return { kind: "route", name, spec: { hosts: list(form.hosts).map((h) => h.toLowerCase()), urls: list(form.urls), middlewares: [...form.middlewares, ...list(form.extraRefs)] } };
};
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ expectedRevision: props.revision, change: change(), ...(force.value ? { force: true } : {}), ...extra });

function fail(err: unknown) {
  error.value = describeError(err);
  inUseApps.value = [];
  if (err instanceof ApiError && err.code === "middleware_in_use" && /applications/.test(err.message)) {
    const used = (err.details as { usedBy?: string[] } | undefined)?.usedBy;
    if (Array.isArray(used)) inUseApps.value = used;
  }
}

async function preview() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<{ before: string; after: string }>("/api/v1/settings/traefik/dynamic/preview", { method: "POST", body: body() });
    before.value = r.before;
    after.value = r.after;
    step.value = "diff";
  } catch (err) {
    fail(err);
    // Une suppression n'a pas de formulaire : l'erreur (et, si possible, « supprimer quand même ») s'affiche sur l'écran de confirmation.
    step.value = props.remove ? "diff" : "form";
  } finally {
    busy.value = false;
  }
}

async function save() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<{ revision: number; sensitive: boolean }>("/api/v1/settings/traefik/dynamic", { method: "PATCH", body: body(message.value ? { message: message.value } : {}) });
    emit("saved", r.revision, r.sensitive);
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => {
  document.addEventListener("keydown", onKey);
  // Une suppression se confirme sur le diff : on le calcule tout de suite.
  if (props.remove) void preview();
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

const title = computed(() => {
  const noun = props.mode === "middleware" ? "le middleware" : "la route";
  if (props.remove) return `Supprimer ${noun} « ${form.name} »`;
  return `${editing ? "Modifier" : "Ajouter"} ${noun}${editing ? ` « ${form.name} »` : ""}`;
});
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="title" class="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">{{ title }}</h2>
          <p class="text-xs text-slate-500">{{ step === "form" ? "1/2 Configuration" : "2/2 Différences de dynamic/dynamic.yml" }}</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div v-if="step === 'form'" class="space-y-4 p-6 text-sm">
        <label class="block">
          <span class="mb-1 block font-medium">Nom</span>
          <input v-model="form.name" :disabled="editing" aria-label="Nom" placeholder="mon-element" :class="[input, 'w-full font-mono text-xs disabled:bg-slate-100']" />
          <span class="mt-1 block text-xs text-slate-500">Minuscules, chiffres, « - » et « _ ». <template v-if="mode === 'middleware'">Les applications le référencent sous la forme <code>{{ form.name || "nom" }}@file</code>.</template></span>
        </label>

        <template v-if="mode === 'middleware'">
          <label class="block">
            <span class="mb-1 block font-medium">Type</span>
            <select v-model="form.type" :disabled="editing" :class="[input, 'w-full disabled:bg-slate-100']" aria-label="Type de middleware">
              <option v-for="t in TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
            </select>
            <span class="mt-1 block text-xs text-slate-500">{{ typeInfo?.help }}</span>
          </label>

          <label v-if="form.type === 'ipAllowList'" class="block">
            <span class="mb-1 block font-medium">Adresses ou plages autorisées</span>
            <textarea v-model="form.sourceRange" rows="3" aria-label="Adresses autorisées" placeholder="10.0.0.0/8&#10;192.168.1.5" :class="[input, 'w-full font-mono text-xs']"></textarea>
            <span class="mt-1 block text-xs text-slate-500">Une par ligne (IPv4 ou IPv6, avec ou sans masque).</span>
          </label>

          <div v-else-if="form.type === 'rateLimit'" class="grid grid-cols-2 gap-4">
            <label><span class="mb-1 block font-medium">Requêtes par seconde (moyenne)</span><input v-model.number="form.average" type="number" min="1" :class="[input, 'w-full']" /></label>
            <label><span class="mb-1 block font-medium">Rafale</span><input v-model.number="form.burst" type="number" min="1" :class="[input, 'w-full']" /></label>
          </div>

          <fieldset v-else-if="form.type === 'headers'" class="space-y-2">
            <legend class="font-medium">En-têtes</legend>
            <label class="flex items-start gap-2"><input v-model="form.hsts" type="checkbox" class="mt-1" /><span>HSTS un an, sous-domaines compris <span class="block text-xs text-slate-500">Force HTTPS dans les navigateurs. Difficile à annuler : à activer quand tout fonctionne en HTTPS.</span></span></label>
            <label class="flex items-center gap-2"><input v-model="form.frameDeny" type="checkbox" /> Interdire l'affichage dans une iframe</label>
            <label class="flex items-center gap-2"><input v-model="form.contentTypeNosniff" type="checkbox" /> Ne pas deviner le type de contenu (nosniff)</label>
            <label class="block"><span class="mb-1 block">Politique de référent</span>
              <select v-model="form.referrerPolicy" :class="[input, 'w-full']" aria-label="Politique de référent"><option v-for="r in REFERRERS" :key="r" :value="r">{{ r || "(aucune)" }}</option></select>
            </label>
          </fieldset>

          <label v-else-if="form.type === 'basicAuth'" class="block">
            <span class="mb-1 block font-medium">Utilisateurs</span>
            <textarea v-model="form.users" rows="3" spellcheck="false" aria-label="Utilisateurs" placeholder="admin:$2y$05$…" :class="[input, 'w-full font-mono text-xs']"></textarea>
            <span class="mt-1 block text-xs text-slate-500">
              Une ligne « nom:empreinte » par utilisateur, avec un mot de passe <strong>déjà haché</strong> : la console n'accepte jamais un mot de passe en clair.
              Génération : <code>htpasswd -nbB nom motdepasse</code>. Le fichier est alors marqué sensible (chiffré dans la sauvegarde Git).
            </span>
          </label>

          <label v-else-if="form.type === 'stripPrefix'" class="block">
            <span class="mb-1 block font-medium">Préfixes retirés</span>
            <textarea v-model="form.prefixes" rows="2" aria-label="Préfixes" placeholder="/api" :class="[input, 'w-full font-mono text-xs']"></textarea>
            <span class="mt-1 block text-xs text-slate-500">Un par ligne, commençant par « / ».</span>
          </label>
        </template>

        <template v-else>
          <label class="block">
            <span class="mb-1 block font-medium">Noms de domaine</span>
            <textarea v-model="form.hosts" rows="2" aria-label="Noms de domaine" placeholder="nas.exemple.fr" :class="[input, 'w-full font-mono text-xs']"></textarea>
            <span class="mt-1 block text-xs text-slate-500">Un par ligne (5 au plus), pointant vers le serveur de Traefik. Le certificat est demandé automatiquement.</span>
          </label>
          <label class="block">
            <span class="mb-1 block font-medium">Adresses des serveurs</span>
            <textarea v-model="form.urls" rows="2" aria-label="Adresses des serveurs" placeholder="http://10.0.0.5:8080" :class="[input, 'w-full font-mono text-xs']"></textarea>
            <span class="mt-1 block text-xs text-slate-500">Une par ligne : <code>http://adresse:port</code> ou <code>https://…</code>. Avec plusieurs, Traefik répartit la charge. Pour un service du même hôte que Traefik, utilisez plutôt « Exposer » dans la fiche de l'application.</span>
          </label>
          <fieldset v-if="middlewareNames.length" class="space-y-1">
            <legend class="font-medium">Middlewares de ce fichier</legend>
            <label v-for="m in middlewareNames" :key="m" class="flex items-center gap-2"><input v-model="form.middlewares" type="checkbox" :value="m" /> <span class="font-mono text-xs">{{ m }}</span></label>
          </fieldset>
          <label class="block">
            <span class="mb-1 block font-medium">Autres middlewares (facultatif)</span>
            <input v-model="form.extraRefs" aria-label="Autres middlewares" placeholder="securite@docker" :class="[input, 'w-full font-mono text-xs']" />
            <span class="mt-1 block text-xs text-slate-500">Un middleware d'un autre fournisseur, avec son suffixe.</span>
          </label>
        </template>
      </div>

      <div v-else class="space-y-3 p-6 text-sm">
        <DiffView v-if="before || after" :before="before" :after="after" />
        <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" :class="[input, 'w-full']" />
        <p class="text-xs text-slate-500">
          Une nouvelle révision de l'application Traefik sera enregistrée ; elle n'est pas déployée automatiquement. Traefik recharge ce fichier tout seul après le déploiement.
        </p>
        <label v-if="inUseApps.length" class="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <input v-model="force" type="checkbox" class="mt-1" />
          <span>Supprimer quand même : les routes de {{ inUseApps.join(", ") }} qui utilisent ce middleware échoueront jusqu'à leur correction.</span>
        </label>
      </div>

      <p v-if="error" role="alert" class="px-6 pb-2 text-sm text-red-700">{{ error }}</p>

      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="step === 'diff' && !remove ? (step = 'form') : emit('close')">{{ step === "diff" && !remove ? "Retour" : "Annuler" }}</button>
        <button v-if="step === 'form'" :disabled="busy || !form.name.trim()" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="preview">Voir les différences</button>
        <button v-else-if="!(remove && error && !inUseApps.length)" :disabled="busy || (remove && inUseApps.length > 0 && !force)" :class="['rounded px-3 py-2 text-white disabled:opacity-50', remove ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700']" @click="save">
          {{ remove ? "Supprimer (nouvelle révision)" : "Enregistrer une révision" }}
        </button>
      </footer>
    </div>
  </div>
</template>
