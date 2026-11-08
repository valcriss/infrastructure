<script setup lang="ts">
import PageTitle from "../components/PageTitle.vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api, describeError, type Container, type Host, type ObservedProject } from "../api";
import CopyButton from "../components/CopyButton.vue";
import DiffView from "../components/DiffView.vue";
import YamlEditor from "../components/YamlEditor.vue";

// Assistant de création en deux étapes : 1) fournir le Compose et le .env ; 2) valider les variables (lesquelles sont
// des secrets, lesquelles vont dans les variables de stack, lesquelles restent écrites dans le Compose).
const route = useRoute();
const adopt = route.query.adopt === "1";
const step = ref<1 | 2>(1);
const hosts = ref<Host[]>([]);
const name = ref("");
const hostId = ref("");
const description = ref("");
const compose = ref("");
const extraText = ref("");
// Fichier .env : préremplit les variables du Compose. Il reste dans cette page, rien n'est enregistré avant la création.
const envText = ref("");
const envInput = ref<HTMLInputElement | null>(null);
/** Variables que l'utilisateur a modifiées à la main : le .env ne les écrase plus. */
const touched = reactive<Record<string, boolean>>({});
/** Variables du .env que le Compose n'utilise pas : à garder (ou non) comme variables de stack. */
const unusedState = reactive<Record<string, { keep: boolean; sensitive: boolean }>>({});
/** Valeurs écrites en clair dans « environment » : restent dans le Compose ou passent en variables. */
const groupState = reactive<Record<string, { move: boolean; name: string; encrypted: boolean; reveal: boolean }>>({});
const error = ref("");
const busy = ref(false);
const editor = ref<InstanceType<typeof YamlEditor> | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
/** Chemins d'origine du projet à importer (libellés Docker des conteneurs). */
const origin = ref<{ dir?: string; files?: string } | null>(null);
const skeleton = ref(false);
const showResult = ref(false);
/** Stack créée : on propose la suite plutôt que de quitter la page. */
const created = ref<{ id: string; literals: number; secrets: number } | null>(null);

const EXAMPLE = `services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "\${PUBLIC_PORT:-8080}:80"
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  db-data:
`;

// --- Analyse du Compose (erreurs avec ligne, variables, valeurs en clair, écarts avec l'existant) ---------------
interface Issue { message: string; line?: number; column?: number }
interface VarRef { name: string; defaultValue?: string; required: boolean; services: string[]; secret: boolean }
interface Difference { level: "warning" | "info"; service?: string; message: string }
interface Group { id: string; name: string; value: string; secret: boolean; shared: boolean; reuse: boolean; uses: { service: string; key: string }[] }
interface Extracted { compose: string; created: { name: string; sensitive: boolean; reused: boolean; uses: number }[] }
interface Analysis {
  valid: boolean;
  issues: Issue[];
  services: string[];
  variables: VarRef[];
  literals: { service: string; key: string; secret: boolean }[];
  /** Valeurs écrites en clair dans « environment », regroupées avec un nom de variable proposé. */
  groups: Group[];
  extracted: Extracted | { error: string } | null;
  differences: Difference[] | null;
  /** Lecture du fichier .env fourni (null : aucun). */
  env: { values: Record<string, string>; issues: { line: number; message: string }[]; interpolated: string[]; unused: { name: string; secret: boolean }[] } | null;
}
const analysis = ref<Analysis | null>(null);
const analyzing = ref(false);
/** Valeurs saisies pour les variables détectées ; l'option « sensible » est pré-cochée pour les secrets probables. */
const values = reactive<Record<string, { value: string; sensitive: boolean }>>({});
let timer: number | undefined;
let seq = 0;

/** « NOM=valeur » par ligne ; les lignes vides et les commentaires sont ignorés. */
function parseVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`Ligne de variable invalide : « ${line} » (attendu NOM=valeur)`);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

function knownValues(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    Object.assign(out, parseVariables(extraText.value));
  } catch {
    /* erreur signalée à l'envoi */
  }
  for (const [k, v] of Object.entries(values)) if (v.value !== "") out[k] = v.value;
  return out;
}

/** Valeurs en clair choisies pour passer en variables de stack. */
const extractPayload = computed(() =>
  (analysis.value?.groups ?? [])
    .filter((g) => groupState[g.id]?.move)
    .map((g) => ({ name: (groupState[g.id] as { name: string }).name.trim(), encrypted: (groupState[g.id] as { encrypted: boolean }).encrypted, uses: g.uses })),
);

async function analyze() {
  const my = ++seq;
  if (!compose.value.trim()) {
    analysis.value = null;
    return;
  }
  analyzing.value = true;
  try {
    const r = await api<Analysis>("/api/v1/compose/analyze", {
      method: "POST",
      body: JSON.stringify({
        compose: compose.value,
        variables: knownValues(),
        ...(envText.value.trim() ? { env: envText.value } : {}),
        ...(step.value === 2 && extractPayload.value.length > 0 ? { extract: extractPayload.value } : {}),
        ...(adopt && hostId.value && name.value ? { hostId: hostId.value, project: name.value } : {}),
      }),
    });
    if (my !== seq) return;
    analysis.value = r;
    for (const v of r.variables) {
      const provided = r.env?.values[v.name];
      const wanted = { value: provided ?? v.defaultValue ?? "", sensitive: v.secret };
      const current = values[v.name];
      if (!current) values[v.name] = wanted;
      else if (!touched[v.name]) Object.assign(current, wanted);
    }
    for (const u of r.env?.unused ?? []) unusedState[u.name] ??= { keep: true, sensitive: u.secret };
    // Les secrets probables passent en variables par défaut ; le reste reste écrit dans le Compose.
    for (const g of r.groups) groupState[g.id] ??= { move: g.secret, name: g.name, encrypted: g.secret, reveal: false };
  } catch {
    if (my === seq) analysis.value = null;
  } finally {
    if (my === seq) analyzing.value = false;
  }
}
function scheduleAnalyze() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void analyze(), 500);
}
watch([compose, hostId, name, envText], scheduleAnalyze);
watch(groupState, () => {
  if (step.value === 2) scheduleAnalyze();
}, { deep: true });
onBeforeUnmount(() => window.clearTimeout(timer));

const detected = computed(() => (analysis.value?.valid ? analysis.value.variables : []));
const groups = computed(() => (analysis.value?.valid ? analysis.value.groups : []));
const extracted = computed(() => analysis.value?.extracted ?? null);
const extractError = computed(() => (extracted.value && "error" in extracted.value ? extracted.value.error : ""));
const resultCompose = computed(() => (extracted.value && "compose" in extracted.value ? extracted.value.compose : compose.value));
const fromEnv = (n: string): boolean => analysis.value?.env?.values[n] !== undefined;
const envCount = computed(() => Object.keys(analysis.value?.env?.values ?? {}).length);

onMounted(async () => {
  hosts.value = (await api<{ hosts: Host[] }>("/api/v1/hosts")).hosts;
  hostId.value = hosts.value[0]?.id ?? "";
  if (!adopt) return;
  hostId.value = String(route.query.host ?? hostId.value);
  name.value = String(route.query.name ?? "");
  // Squelette de départ : les services et images observés. Le Compose d'origine n'est pas
  // reconstructible depuis les conteneurs seuls (ports, volumes, variables…).
  const found = (await api<{ projects: ObservedProject[] }>(`/api/v1/hosts/${hostId.value}/projects`)).projects.find((p) => p.name === name.value);
  compose.value = [
    "# ATTENTION : squelette à compléter avec le Compose d'ORIGINE du projet.",
    "# Les ports, volumes, variables, réseaux… ne sont pas repris : un déploiement",
    "# avec un Compose incomplet recréerait les conteneurs sans eux.",
    "services:",
    ...(found?.services ?? []).flatMap((s) => [`  ${s.service}:`, `    image: ${s.image}`]),
    "",
  ].join("\n");
  skeleton.value = true;
  try {
    const d = await api<{ containers: Container[] }>(`/api/v1/hosts/${hostId.value}/projects/${encodeURIComponent(name.value)}`);
    const c = d.containers.find((x) => x.composeWorkingDir || x.composeConfigFiles);
    if (c) origin.value = { ...(c.composeWorkingDir ? { dir: c.composeWorkingDir } : {}), ...(c.composeConfigFiles ? { files: c.composeConfigFiles } : {}) };
  } catch {
    /* les chemins sont une aide : leur absence ne bloque pas l'import */
  }
});

// --- Étape 1 : sources du Compose et du .env -------------------------------------------------------------------
function useExample() {
  if (compose.value.trim() && !window.confirm("Remplacer le contenu actuel par l'exemple ?")) return;
  compose.value = EXAMPLE;
  skeleton.value = false;
}
async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 1_000_000) {
    error.value = "Fichier trop volumineux (1 Mo maximum).";
    return;
  }
  if (compose.value.trim() && !window.confirm(`Remplacer le contenu actuel par « ${f.name} » ?`)) return;
  error.value = "";
  compose.value = await f.text();
  skeleton.value = false;
  if (fileInput.value) fileInput.value.value = "";
}
async function onEnvFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 200_000) {
    error.value = "Fichier .env trop volumineux (200 Ko maximum).";
    return;
  }
  error.value = "";
  envText.value = await file.text();
  if (envInput.value) envInput.value.value = "";
}
function goToLine(i: Issue) {
  if (i.line) editor.value?.goToLine(i.line, i.column ?? 1);
}

const nameOk = computed(() => /^[a-z0-9][a-z0-9_-]*$/.test(name.value));
const canNext = computed(() => nameOk.value && !!hostId.value && !!compose.value.trim() && !!analysis.value?.valid && !analyzing.value);
const nextHint = computed(() => {
  if (!nameOk.value) return "Renseignez un nom valide (minuscules, chiffres, - et _).";
  if (!compose.value.trim()) return "Fournissez le Compose.";
  if (analysis.value && !analysis.value.valid) return "Corrigez les erreurs du Compose.";
  if (analyzing.value || !analysis.value) return "Analyse en cours…";
  return "";
});
async function next() {
  error.value = "";
  step.value = 2;
  window.clearTimeout(timer);
  await analyze();
}
function back() {
  step.value = 1;
  error.value = "";
}

// --- Étape 2 : validation et création ---------------------------------------------------------------------------
const missingRequired = computed(() => detected.value.filter((v) => v.required && (values[v.name]?.value ?? "") === "" && !(v.name in safeExtra())));
function safeExtra(): Record<string, string> {
  try {
    return parseVariables(extraText.value);
  } catch {
    return {};
  }
}
const movedGroups = computed(() => groups.value.filter((g) => groupState[g.id]?.move));
const keptGroups = computed(() => groups.value.filter((g) => !groupState[g.id]?.move));
const sensitiveCount = computed(
  () =>
    detected.value.filter((v) => values[v.name]?.sensitive && values[v.name]?.value !== "").length +
    movedGroups.value.filter((g) => groupState[g.id]?.encrypted).length +
    (analysis.value?.env?.unused ?? []).filter((u) => unusedState[u.name]?.keep && unusedState[u.name]?.sensitive).length,
);
const keptUnused = computed(() => (analysis.value?.env?.unused ?? []).filter((u) => unusedState[u.name]?.keep));
const keptSecretLiterals = computed(() => keptGroups.value.filter((g) => g.secret).reduce((n, g) => n + g.uses.length, 0));

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const variables: Record<string, string | { value: string; sensitive: boolean }> = {};
    const extra = parseVariables(extraText.value);
    for (const [k, v] of Object.entries(extra)) variables[k] = v;
    for (const v of detected.value) {
      const e = values[v.name];
      if (!e) continue;
      if (e.value === "" && v.required && !(v.name in extra)) throw new Error(`La variable ${v.name} est obligatoire (aucune valeur par défaut dans le Compose) : renseignez-la.`);
      if (e.value !== "") variables[v.name] = { value: e.value, sensitive: e.sensitive };
    }
    // Variables du .env que le Compose n'utilise pas et que l'on garde (fichiers associés, env_file…).
    for (const u of analysis.value?.env?.unused ?? []) {
      const st = unusedState[u.name];
      const value = analysis.value?.env?.values[u.name] ?? "";
      if (st?.keep && value !== "" && !(u.name in variables)) variables[u.name] = { value, sensitive: st.sensitive };
    }
    if (extractError.value) throw new Error(`Passage en variables impossible : ${extractError.value}`);
    const r = await api<{ id: string }>("/api/v1/stacks", {
      method: "POST",
      body: JSON.stringify({
        name: name.value,
        hostId: hostId.value,
        description: description.value,
        compose: compose.value,
        variables,
        adopt,
        ...(extractPayload.value.length > 0 ? { extract: extractPayload.value } : {}),
      }),
    });
    created.value = { id: r.id, literals: keptGroups.value.reduce((n, g) => n + g.uses.length, 0), secrets: keptSecretLiterals.value };
  } catch (err) {
    error.value = err instanceof Error && !("status" in err) ? err.message : describeError(err);
  } finally {
    busy.value = false;
  }
}

const MANUAL_CHECKS = [
  "Les fichiers référencés par le Compose (env_file, configurations) existent côté console : les ajouter dans l'onglet Fichiers.",
  "Les valeurs des variables et secrets sont celles actuellement utilisées par l'application en marche.",
  "Les réseaux, les volumes nommés (et leur nom exact) et les dépendances externes correspondent à l'existant.",
  "Les paramètres que la console ne peut pas observer (limites de ressources, politique de redémarrage, utilisateur, commandes) sont identiques.",
];
const STEPS = [
  { n: 1, label: "Fichiers" },
  { n: 2, label: "Variables et secrets" },
] as const;
</script>

<template>
  <div class="space-y-6">
    <PageTitle :title="adopt ? 'Importer un projet existant' : 'Nouvelle application'" :icon="adopt ? 'download' : 'plus'" />

    <section v-if="created" role="status" class="max-w-3xl space-y-3 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900">
      <p class="font-medium">{{ adopt ? "Projet importé" : "Application créée" }} : la révision 1 est enregistrée, rien n'a été déployé.</p>
      <p v-if="created.literals > 0">
        {{ created.literals }} valeur(s) restent écrites en clair dans le Compose<template v-if="created.secrets > 0"> dont {{ created.secrets }} ressemblant à un secret</template> :
        vous pouvez les transformer en variables (les secrets chiffrés) avec « Extraire les variables… » dans le menu Outils de la configuration.
      </p>
      <div class="flex flex-wrap gap-3">
        <RouterLink :to="{ path: `/stacks/${created.id}`, query: { deploy: '1' } }" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700">Préparer le premier déploiement</RouterLink>
        <RouterLink :to="`/stacks/${created.id}`" class="rounded border border-green-400 bg-white px-3 py-2 text-slate-900 hover:bg-green-100">Ouvrir l'application</RouterLink>
      </div>
    </section>

    <template v-else>
      <ol class="flex max-w-3xl items-center gap-3 text-sm" aria-label="Étapes">
        <li v-for="s in STEPS" :key="s.n" class="flex items-center gap-2" :aria-current="step === s.n ? 'step' : undefined">
          <span :class="['flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold', step === s.n ? 'bg-blue-600 text-white' : step > s.n ? 'bg-green-600 text-white' : 'bg-slate-200 text-slate-600']">{{ s.n }}</span>
          <span :class="step === s.n ? 'font-medium' : 'text-slate-500'">{{ s.label }}</span>
          <span v-if="s.n < STEPS.length" class="mx-1 h-px w-8 bg-slate-300" aria-hidden="true"></span>
        </li>
      </ol>

      <!-- Étape 1 : fournir le Compose et le .env -->
      <form v-show="step === 1" class="max-w-3xl space-y-4" @submit.prevent="canNext && next()">
        <section v-if="adopt" role="note" class="space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p class="font-medium">Import d'un projet Compose déjà en marche</p>
          <p>
            Renseignez le fichier Compose d'origine. La création n'enregistre que la configuration : rien n'est modifié sur l'hôte. Au premier déploiement, Docker Compose recréera les conteneurs dont la configuration diffère
            (une prévisualisation figure dans le journal), mais ne supprimera jamais les services absents de ce Compose. Les données des volumes ne sont pas touchées.
          </p>
          <div class="rounded border border-amber-400 bg-white p-3 text-slate-900">
            <p class="font-medium">Compose d'origine</p>
            <dl v-if="origin" class="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <template v-if="origin.dir"><dt class="text-slate-500">Dossier</dt><dd class="break-all font-mono text-xs">{{ origin.dir }}<CopyButton :text="origin.dir" label="Copier le dossier du projet" /></dd></template>
              <template v-if="origin.files"><dt class="text-slate-500">Fichier(s)</dt><dd class="break-all font-mono text-xs font-semibold">{{ origin.files }}<CopyButton :text="origin.files" label="Copier le chemin du fichier Compose" /></dd></template>
            </dl>
            <p v-else class="mt-1 text-xs text-slate-600">Les conteneurs n'indiquent pas où se trouve le fichier Compose : retrouvez-le sur l'hôte.</p>
            <p class="mt-2 text-xs text-slate-600">Ouvrez ce fichier sur l'hôte et collez-le ci-dessous (ou chargez-le), avec le .env utilisé. Le texte prérempli n'est qu'un <strong>squelette de reconstruction</strong> (services et images) : il ne remplace pas le fichier d'origine.</p>
          </div>
        </section>

        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block text-sm">
            <span class="font-medium">Nom (nom du projet Compose)</span>
            <input v-model="name" :readonly="adopt" required pattern="[a-z0-9][a-z0-9_-]*" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 read-only:bg-slate-100" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Hôte cible</span>
            <select v-model="hostId" :disabled="adopt" required class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
              <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name }}{{ h.presence === "online" ? "" : " (hors ligne)" }}</option>
            </select>
          </label>
        </div>
        <label class="block text-sm">
          <span class="font-medium">Description (optionnelle)</span>
          <input v-model="description" maxlength="500" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>

        <div class="text-sm">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-medium">Compose</span>
            <span class="flex flex-wrap gap-2">
              <input ref="fileInput" type="file" accept=".yml,.yaml,text/yaml,text/plain" class="sr-only" aria-label="Charger un fichier Compose" @change="onFile" />
              <button type="button" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="fileInput?.click()">Charger un fichier</button>
              <button v-if="!adopt" type="button" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="useExample">Partir d'un exemple</button>
            </span>
          </div>
          <p class="text-xs text-slate-500">
            Collez votre fichier dans l'éditeur, chargez-le, ou partez d'un exemple. Images préconstruites uniquement : « build » et « include » ne sont pas supportés.
          </p>
          <p v-if="skeleton" class="mt-1 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">Squelette de reconstruction : remplacez-le par le Compose d'origine avant de continuer.</p>
          <div class="mt-1"><YamlEditor ref="editor" v-model="compose" label="Fichier Compose" /></div>
          <div v-if="analysis && !analysis.valid" role="alert" class="mt-2 rounded border border-red-300 bg-red-50 p-3 text-red-900">
            <p class="font-medium">Ce Compose est invalide ({{ analysis.issues.length }} problème{{ analysis.issues.length > 1 ? "s" : "" }}) :</p>
            <ul class="mt-1 space-y-1">
              <li v-for="(i, n) in analysis.issues" :key="n" class="flex flex-wrap items-center gap-2">
                <button v-if="i.line" type="button" class="rounded border border-red-300 bg-white px-2 py-0.5 text-xs hover:bg-red-100" @click="goToLine(i)">ligne {{ i.line }}<template v-if="i.column">, col. {{ i.column }}</template></button>
                <span>{{ i.message }}</span>
              </li>
            </ul>
          </div>
          <p v-else-if="analysis?.valid" class="mt-2 text-xs text-green-700">Compose valide : {{ analysis.services.length }} service(s) ({{ analysis.services.join(", ") }}).</p>
        </div>

        <section aria-label="Fichier .env" class="rounded border border-slate-200 bg-white p-4 text-sm">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="font-semibold">Fichier .env (facultatif)</h2>
            <span>
              <input ref="envInput" type="file" class="sr-only" aria-label="Charger un fichier .env" @change="onEnvFile" />
              <button type="button" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="envInput?.click()">Charger un fichier</button>
            </span>
          </div>
          <p class="text-xs text-slate-500">
            Collez ou chargez votre .env (ou .env.prod) : à l'étape suivante, les variables du Compose sont préremplies et les secrets cochés « sensibles ». Le texte reste dans cette page ; rien n'est enregistré avant la création.
          </p>
          <textarea v-model="envText" rows="5" spellcheck="false" autocomplete="off" aria-label="Contenu du fichier .env" placeholder="NOM=valeur" class="mt-2 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"></textarea>
          <p v-if="analysis?.env && envCount > 0" class="mt-1 text-xs text-green-700">{{ envCount }} variable(s) lue(s), dont {{ envCount - analysis.env.unused.length }} utilisée(s) par le Compose.</p>
          <ul v-if="analysis?.env?.issues.length" role="alert" class="mt-1 space-y-0.5 text-xs text-amber-800">
            <li v-for="i in analysis.env.issues" :key="i.line">Ligne {{ i.line }} : {{ i.message }}</li>
          </ul>
          <p v-if="analysis?.env?.interpolated.length" role="alert" class="mt-1 rounded bg-amber-50 p-2 text-xs text-amber-900">
            Ces valeurs contiennent un « $ » que Docker Compose interprète en lisant un .env : {{ analysis.env.interpolated.join(", ") }}. La console les enregistre telles quelles (sans interprétation) ; vérifiez-les à l'étape suivante.
          </p>
        </section>

        <p v-if="error && step === 1" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <button :disabled="!canNext" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">Suivant : variables et secrets</button>
          <RouterLink to="/stacks" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100">Annuler</RouterLink>
          <span v-if="!canNext" class="text-xs text-slate-500">{{ nextHint }}</span>
        </div>
      </form>

      <!-- Étape 2 : variables, secrets et valeurs en clair -->
      <form v-if="step === 2" class="max-w-4xl space-y-5" @submit.prevent="submit">
        <section v-if="detected.length" aria-label="Variables du Compose" class="rounded border border-slate-200 bg-white p-4 text-sm">
          <h2 class="font-semibold">Variables référencées par le Compose <span class="font-normal text-slate-500">(→ variables de stack)</span></h2>
          <p class="text-xs text-slate-500">Une variable « sensible » est masquée dans la console et chiffrée dans la sauvegarde Git ; les secrets probables sont déjà cochés. Une valeur laissée vide prend la valeur par défaut du Compose.</p>
          <table class="mt-2 w-full text-left">
            <thead class="text-xs text-slate-500"><tr><th class="py-1 pr-2">Variable</th><th class="py-1 pr-2">Valeur</th><th class="py-1">Sensible</th></tr></thead>
            <tbody>
              <tr v-for="v in detected" :key="v.name" class="border-t border-slate-100 align-top">
                <td class="py-2 pr-2">
                  <span class="font-mono text-xs">{{ v.name }}</span>
                  <span v-if="v.required" class="ml-1 rounded bg-red-100 px-1.5 text-xs text-red-800">obligatoire</span>
                  <span v-else-if="v.defaultValue !== undefined" class="ml-1 rounded bg-slate-100 px-1.5 text-xs text-slate-600">défaut : {{ v.defaultValue === "" ? "(vide)" : v.defaultValue }}</span>
                  <span v-if="fromEnv(v.name) && !touched[v.name]" class="ml-1 rounded bg-green-100 px-1.5 text-xs text-green-800">fournie par le .env</span>
                  <span v-if="v.secret" class="ml-1 rounded bg-amber-100 px-1.5 text-xs text-amber-800">secret probable</span>
                  <span v-if="v.services.length" class="block text-xs text-slate-500">{{ v.services.join(", ") }}</span>
                </td>
                <td class="py-2 pr-2">
                  <input
                    v-if="values[v.name]"
                    v-model="values[v.name]!.value"
                    :type="values[v.name]!.sensitive ? 'password' : 'text'"
                    autocomplete="off"
                    :aria-label="'Valeur de ' + v.name"
                    :placeholder="v.defaultValue !== undefined ? 'défaut : ' + v.defaultValue : ''"
                    class="w-full rounded border px-2 py-1 font-mono text-xs"
                    :class="v.required && values[v.name]!.value === '' ? 'border-red-400' : 'border-slate-300'"
                    @input="touched[v.name] = true"
                  />
                </td>
                <td class="py-2"><input v-if="values[v.name]" v-model="values[v.name]!.sensitive" type="checkbox" :aria-label="v.name + ' est sensible'" @change="touched[v.name] = true" /></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="groups.length" aria-label="Valeurs écrites dans le Compose" class="rounded border border-slate-200 bg-white p-4 text-sm">
          <h2 class="font-semibold">Valeurs écrites en clair dans le Compose <span class="font-normal text-slate-500">(section « environment »)</span></h2>
          <p class="text-xs text-slate-500">
            Laissées dans le Compose, elles restent visibles dans chaque révision. Passées en variables, elles sont remplacées par <code>${NOM}</code> dans le Compose et peuvent être chiffrées. Les secrets probables sont proposés en variables.
          </p>
          <table class="mt-2 w-full text-left">
            <thead class="text-xs text-slate-500"><tr><th class="py-1 pr-2">Service / clé</th><th class="py-1 pr-2">Valeur</th><th class="py-1 pr-2">Destination</th><th class="py-1 pr-2">Variable</th><th class="py-1">Sensible</th></tr></thead>
            <tbody>
              <tr v-for="g in groups" :key="g.id" class="border-t border-slate-100 align-top">
                <td class="py-2 pr-2">
                  <span class="font-mono text-xs">{{ g.uses[0]?.service }} / {{ g.uses[0]?.key }}</span>
                  <span v-if="g.uses.length > 1" class="block text-xs text-slate-500">+ {{ g.uses.length - 1 }} autre(s) usage(s) de la même valeur</span>
                  <span v-if="g.secret" class="mt-0.5 inline-block rounded bg-amber-100 px-1.5 text-xs text-amber-800">secret probable</span>
                </td>
                <td class="py-2 pr-2 font-mono text-xs">
                  <template v-if="groupState[g.id]">
                    <span class="break-all">{{ g.secret && !groupState[g.id]!.reveal ? "••••••••" : g.value }}</span>
                    <button v-if="g.secret" type="button" class="ml-1 underline" @click="groupState[g.id]!.reveal = !groupState[g.id]!.reveal">{{ groupState[g.id]!.reveal ? "masquer" : "voir" }}</button>
                  </template>
                </td>
                <td class="py-2 pr-2">
                  <select v-if="groupState[g.id]" v-model="groupState[g.id]!.move" :aria-label="'Destination de ' + (g.uses[0]?.key ?? '')" class="rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                    <option :value="false">Rester dans le Compose</option>
                    <option :value="true">Passer en variable</option>
                  </select>
                </td>
                <td class="py-2 pr-2">
                  <input v-if="groupState[g.id]?.move" v-model="groupState[g.id]!.name" :aria-label="'Nom de la variable pour ' + (g.uses[0]?.key ?? '')" class="w-44 rounded border border-slate-300 px-2 py-1 font-mono text-xs" />
                </td>
                <td class="py-2"><input v-if="groupState[g.id]?.move" v-model="groupState[g.id]!.encrypted" type="checkbox" :aria-label="'Variable ' + groupState[g.id]!.name + ' sensible'" /></td>
              </tr>
            </tbody>
          </table>
          <p v-if="extractError" role="alert" class="mt-2 text-sm text-red-700">{{ extractError }}</p>
          <p v-if="keptSecretLiterals > 0" role="status" class="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
            {{ keptSecretLiterals }} valeur(s) ressemblant à des secrets resteront en clair dans le Compose et dans chaque révision.
          </p>
        </section>

        <section v-if="analysis?.env?.unused.length" aria-label="Variables du .env non utilisées" class="rounded border border-slate-200 bg-white p-4 text-sm">
          <h2 class="font-semibold">Variables du .env que le Compose n'utilise pas</h2>
          <p class="text-xs text-slate-500">Utiles si un fichier associé (env_file, configuration) les lit ; sinon décochez-les. Une variable « sensible » est masquée et chiffrée dans la sauvegarde Git.</p>
          <table class="mt-2 w-full text-left">
            <thead class="text-xs text-slate-500"><tr><th class="py-1 pr-2">Garder</th><th class="py-1 pr-2">Variable</th><th class="py-1">Sensible</th></tr></thead>
            <tbody>
              <tr v-for="u in analysis.env.unused" :key="u.name" class="border-t border-slate-100">
                <td class="py-1.5 pr-2"><input v-if="unusedState[u.name]" v-model="unusedState[u.name]!.keep" type="checkbox" :aria-label="'Garder ' + u.name" /></td>
                <td class="py-1.5 pr-2 font-mono text-xs">{{ u.name }}<span v-if="u.secret" class="ml-1 rounded bg-amber-100 px-1.5 font-sans text-xs text-amber-800">secret probable</span></td>
                <td class="py-1.5"><input v-if="unusedState[u.name]" v-model="unusedState[u.name]!.sensitive" type="checkbox" :aria-label="u.name + ' est sensible'" /></td>
              </tr>
            </tbody>
          </table>
        </section>

        <details class="text-sm">
          <summary class="cursor-pointer font-medium">Variables supplémentaires (NOM=valeur, une par ligne)</summary>
          <textarea v-model="extraText" rows="3" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs" @input="scheduleAnalyze"></textarea>
          <span class="text-xs text-slate-500">Pour des variables non référencées par le Compose (utilisées par des fichiers). Elles ne sont pas sensibles ; marquez-les ensuite depuis l'onglet Configuration.</span>
        </details>

        <section v-if="adopt && analysis?.valid && analysis.differences" aria-label="Écarts avec l'existant" class="rounded border border-slate-200 bg-white p-4 text-sm">
          <h2 class="font-semibold">Écarts avec ce qui tourne actuellement</h2>
          <p v-if="analysis.differences.length === 0" class="mt-1 text-green-700">Services, ports publiés et montages concordent avec les conteneurs observés.</p>
          <ul v-else class="mt-2 space-y-1">
            <li v-for="(d, n) in analysis.differences" :key="n" :class="d.level === 'warning' ? 'text-amber-800' : 'text-slate-600'">
              <FaIcon :icon="['fas', d.level === 'warning' ? 'triangle-exclamation' : 'circle-info']" /> {{ d.message }}
            </li>
          </ul>
          <h3 class="mt-4 font-medium">À vérifier à la main (la console ne peut pas le voir)</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-slate-700">
            <li v-for="c in MANUAL_CHECKS" :key="c">{{ c }}</li>
          </ul>
        </section>

        <section aria-label="Résumé" class="rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
          <h2 class="font-semibold">Résumé</h2>
          <ul class="mt-1 list-disc space-y-0.5 pl-5">
            <li>{{ detected.length }} variable(s) référencée(s) par le Compose, {{ movedGroups.length }} valeur(s) passée(s) du Compose en variable, {{ keptUnused.length }} variable(s) du .env conservée(s).</li>
            <li>{{ sensitiveCount }} variable(s) sensible(s) (masquées et chiffrées dans la sauvegarde Git).</li>
            <li>{{ keptGroups.length }} valeur(s) laissée(s) en clair dans le Compose.</li>
          </ul>
          <p v-if="missingRequired.length" role="alert" class="mt-2 text-red-800">Variable(s) obligatoire(s) sans valeur : {{ missingRequired.map((v) => v.name).join(", ") }}.</p>
          <div v-if="extracted && 'compose' in extracted" class="mt-2">
            <button type="button" class="underline" :aria-expanded="showResult" @click="showResult = !showResult">{{ showResult ? "Masquer" : "Voir" }} le Compose qui sera enregistré</button>
            <div v-if="showResult" class="mt-2 text-slate-900"><DiffView :before="compose" :after="resultCompose" /></div>
          </div>
        </section>

        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100" @click="back">Retour</button>
          <button :disabled="busy || !hostId || analyzing || !!extractError || missingRequired.length > 0" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{{ adopt ? "Importer la stack" : "Créer la stack" }}</button>
          <RouterLink to="/stacks" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100">Annuler</RouterLink>
        </div>
        <p class="text-xs text-slate-500">La création enregistre la révision 1 sans rien déployer ; vous pourrez ensuite préparer le premier déploiement.</p>
      </form>
    </template>
  </div>
</template>
