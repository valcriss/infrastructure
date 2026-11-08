<script setup lang="ts">
import PageTitle from "../components/PageTitle.vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api, describeError, type Container, type Host, type ObservedProject } from "../api";
import CopyButton from "../components/CopyButton.vue";
import YamlEditor from "../components/YamlEditor.vue";

const route = useRoute();
const adopt = route.query.adopt === "1";
const hosts = ref<Host[]>([]);
const name = ref("");
const hostId = ref("");
const description = ref("");
const compose = ref("");
const extraText = ref("");
const error = ref("");
const busy = ref(false);
const editor = ref<InstanceType<typeof YamlEditor> | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
/** Chemins d'origine du projet à importer (libellés Docker des conteneurs). */
const origin = ref<{ dir?: string; files?: string } | null>(null);
const skeleton = ref(false);
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

// --- Analyse du Compose (erreurs avec ligne, variables, écarts avec l'existant) ------------------------------
interface Issue { message: string; line?: number; column?: number }
interface VarRef { name: string; defaultValue?: string; required: boolean; services: string[]; secret: boolean }
interface Difference { level: "warning" | "info"; service?: string; message: string }
interface Analysis {
  valid: boolean;
  issues: Issue[];
  services: string[];
  variables: VarRef[];
  literals: { service: string; key: string; secret: boolean }[];
  differences: Difference[] | null;
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
        ...(adopt && hostId.value && name.value ? { hostId: hostId.value, project: name.value } : {}),
      }),
    });
    if (my !== seq) return;
    analysis.value = r;
    for (const v of r.variables) {
      if (!values[v.name]) values[v.name] = { value: v.defaultValue ?? "", sensitive: v.secret };
    }
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
watch([compose, hostId, name], scheduleAnalyze);
onBeforeUnmount(() => window.clearTimeout(timer));

const detected = computed(() => (analysis.value?.valid ? analysis.value.variables : []));
const secretLiterals = computed(() => analysis.value?.literals.filter((l) => l.secret).length ?? 0);

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

// --- Sources du Compose : coller, charger un fichier, exemple ------------------------------------------------
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
function goToLine(i: Issue) {
  if (i.line) editor.value?.goToLine(i.line, i.column ?? 1);
}

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
    const r = await api<{ id: string }>("/api/v1/stacks", {
      method: "POST",
      body: JSON.stringify({ name: name.value, hostId: hostId.value, description: description.value, compose: compose.value, variables, adopt }),
    });
    created.value = { id: r.id, literals: analysis.value?.literals.length ?? 0, secrets: secretLiterals.value };
  } catch (err) {
    error.value = err instanceof Error && !("status" in err) ? err.message : describeError(err);
  } finally {
    busy.value = false;
  }
}

const MANUAL_CHECKS = [
  "Les fichiers référencés par le Compose (.env, env_file, configurations) existent côté console : les ajouter dans l'onglet Fichiers.",
  "Les valeurs des variables et secrets sont celles actuellement utilisées par l'application en marche.",
  "Les réseaux, les volumes nommés (et leur nom exact) et les dépendances externes correspondent à l'existant.",
  "Les paramètres que la console ne peut pas observer (limites de ressources, politique de redémarrage, utilisateur, commandes) sont identiques.",
];
</script>

<template>
  <div class="space-y-6">
    <PageTitle :title="adopt ? 'Importer un projet existant' : 'Nouvelle application'" :icon="adopt ? 'download' : 'plus'" />

    <section v-if="created" role="status" class="max-w-3xl space-y-3 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900">
      <p class="font-medium">{{ adopt ? "Projet importé" : "Application créée" }} : la révision 1 est enregistrée, rien n'a été déployé.</p>
      <p v-if="created.literals > 0">
        {{ created.literals }} valeur(s) sont écrites en clair dans le Compose<template v-if="created.secrets > 0"> dont {{ created.secrets }} ressemblant à un secret</template> :
        vous pouvez les transformer en variables (les secrets chiffrés) avec « Extraire les variables… » dans la configuration.
      </p>
      <div class="flex flex-wrap gap-3">
        <RouterLink :to="{ path: `/stacks/${created.id}`, query: { deploy: '1' } }" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700">Préparer le premier déploiement</RouterLink>
        <RouterLink v-if="created.literals > 0" :to="`/stacks/${created.id}?tab=config&section=compose`" class="rounded border border-green-400 bg-white px-3 py-2 text-slate-900 hover:bg-green-100">Extraire les variables</RouterLink>
        <RouterLink :to="`/stacks/${created.id}`" class="rounded border border-green-400 bg-white px-3 py-2 text-slate-900 hover:bg-green-100">Ouvrir l'application</RouterLink>
      </div>
    </section>

    <template v-else>
      <section v-if="adopt" role="note" class="max-w-3xl space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
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
          <p class="mt-2 text-xs text-slate-600">Ouvrez ce fichier sur l'hôte et collez-le ci-dessous (ou chargez-le). Le texte prérempli n'est qu'un <strong>squelette de reconstruction</strong> (services et images) : il ne remplace pas le fichier d'origine.</p>
        </div>
      </section>

      <form class="max-w-3xl space-y-4" @submit.prevent="submit">
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
          <p v-if="skeleton" class="mt-1 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">Squelette de reconstruction : remplacez-le par le Compose d'origine avant de créer.</p>
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

        <section v-if="detected.length" aria-label="Variables détectées" class="rounded border border-slate-200 bg-white p-4 text-sm">
          <h2 class="font-semibold">Variables détectées dans le Compose</h2>
          <p class="text-xs text-slate-500">Renseignez les valeurs avant l'enregistrement. Une variable « sensible » est masquée dans la console et chiffrée dans la sauvegarde Git ; les secrets probables sont déjà cochés.</p>
          <table class="mt-2 w-full text-left">
            <thead class="text-xs text-slate-500"><tr><th class="py-1 pr-2">Variable</th><th class="py-1 pr-2">Valeur</th><th class="py-1">Sensible</th></tr></thead>
            <tbody>
              <tr v-for="v in detected" :key="v.name" class="border-t border-slate-100 align-top">
                <td class="py-2 pr-2">
                  <span class="font-mono text-xs">{{ v.name }}</span>
                  <span v-if="v.required" class="ml-1 rounded bg-red-100 px-1.5 text-xs text-red-800">obligatoire</span>
                  <span v-else-if="v.defaultValue !== undefined" class="ml-1 rounded bg-slate-100 px-1.5 text-xs text-slate-600">défaut : {{ v.defaultValue === "" ? "(vide)" : v.defaultValue }}</span>
                  <span v-if="v.secret" class="ml-1 rounded bg-amber-100 px-1.5 text-xs text-amber-800">secret probable</span>
                  <span v-if="v.services.length" class="block text-xs text-slate-500">{{ v.services.join(", ") }}</span>
                </td>
                <td class="py-2 pr-2">
                  <input
                    v-if="values[v.name]"
                    v-model="values[v.name]!.value"
                    :type="values[v.name]!.sensitive ? 'password' : 'text'"
                    autocomplete="off"
                    :aria-label="`Valeur de ${v.name}`"
                    :placeholder="v.defaultValue !== undefined ? `défaut : ${v.defaultValue}` : ''"
                    class="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                  />
                </td>
                <td class="py-2"><input v-if="values[v.name]" v-model="values[v.name]!.sensitive" type="checkbox" :aria-label="`${v.name} est sensible`" /></td>
              </tr>
            </tbody>
          </table>
        </section>
        <p v-if="analysis?.valid && secretLiterals > 0" class="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {{ secretLiterals }} valeur(s) ressemblant à des secrets sont écrites en clair dans « environment ». Elles resteront visibles dans la révision : après la création, utilisez « Extraire les variables… » pour les chiffrer.
        </p>

        <details class="text-sm">
          <summary class="cursor-pointer font-medium">Variables supplémentaires (NOM=valeur, une par ligne)</summary>
          <textarea v-model="extraText" rows="3" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs" @input="scheduleAnalyze"></textarea>
          <span class="text-xs text-slate-500">Pour des variables non référencées par le Compose (utilisées par des fichiers). Elles ne sont pas sensibles ; marquez-les ensuite depuis l'onglet Configuration.</span>
        </details>

        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <div class="flex gap-3">
          <button :disabled="busy || !hostId || analyzing" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{{ adopt ? "Importer la stack" : "Créer la stack" }}</button>
          <RouterLink to="/stacks" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100">Annuler</RouterLink>
        </div>
        <p class="text-xs text-slate-500">La création enregistre la révision 1 sans rien déployer ; vous pourrez ensuite préparer le premier déploiement.</p>
      </form>
    </template>
  </div>
</template>
