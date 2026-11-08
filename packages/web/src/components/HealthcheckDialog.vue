<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api, describeError, type ChangeResult, type Container } from "../api";
import DiffView from "./DiffView.vue";

// Ajout d'un healthcheck à un service : choix du modèle et des paramètres, aperçu du diff Compose, puis enregistrement d'une révision.
// Le modèle s'adapte aux outils réellement présents dans le conteneur (curl, wget, node, python, bash…).
const props = defineProps<{ stackId: string; hostId: string; revision: number; service: string; container: Container }>();
const emit = defineEmits<{ close: []; saved: [revision: number]; customImage: [] }>();

type Kind = "mysql" | "mariadb" | "postgres" | "redis" | "mongo" | "web" | "tcp" | "custom";
type Tools = Set<string>;

interface Probe {
  tools: string[];
  packageManager: string | null;
  user: string;
  shell: boolean;
}

/** Test HTTP avec le premier outil disponible ; sans information (sonde en cours ou échouée), deux outils en repli. */
function webCommand(port: number, t: Tools | null): string {
  const url = `http://127.0.0.1:${port}/`;
  if (t?.has("curl")) return `curl -fsS -o /dev/null ${url}`;
  if (t?.has("wget")) return `wget -q -O /dev/null ${url}`;
  if (t?.has("node")) return `node -e "require('http').get('${url}',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"`;
  if (t?.has("python3")) return `python3 -c "import urllib.request as u;u.urlopen('${url}',timeout=5)"`;
  if (t?.has("python")) return `python -c "import urllib.request as u;u.urlopen('${url}',timeout=5)"`;
  if (t?.has("bash")) return `bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}"`;
  return `wget -q -O /dev/null ${url} || curl -fsS -o /dev/null ${url}`;
}

function tcpCommand(port: number, t: Tools | null): string {
  if (t?.has("bash")) return `bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}"`;
  if (t?.has("node")) return `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
  return `nc -z 127.0.0.1 ${port}`;
}

const TEMPLATES: Record<Kind, { label: string; group: string; test: (port: number, t: Tools | null) => string }> = {
  mysql: { label: "MySQL", group: "Base de données", test: () => "mysqladmin ping -h 127.0.0.1 --silent" },
  mariadb: { label: "MariaDB", group: "Base de données", test: () => "mariadb-admin ping -h 127.0.0.1 --silent || mysqladmin ping -h 127.0.0.1 --silent" },
  postgres: { label: "PostgreSQL", group: "Base de données", test: () => "pg_isready -h 127.0.0.1" },
  redis: { label: "Redis / Valkey", group: "Base de données", test: () => "redis-cli ping | grep -q PONG" },
  mongo: { label: "MongoDB", group: "Base de données", test: () => "mongosh --quiet --eval \"db.adminCommand('ping').ok\" | grep -q 1" },
  web: { label: "Web (HTTP)", group: "Réseau", test: webCommand },
  tcp: { label: "Port TCP ouvert", group: "Réseau", test: tcpCommand },
  custom: { label: "Personnalisé", group: "Autre", test: () => "" },
};

/** Devine le modèle d'après le nom de l'image ; « null » si rien de fiable. */
function detect(image: string): Kind | null {
  const name = (image.split("@")[0] ?? "").replace(/:[^/:]*$/, "").split("/").pop()?.toLowerCase() ?? "";
  if (name === "mysql") return "mysql";
  if (name === "mariadb") return "mariadb";
  if (name.startsWith("postgres") || name === "timescaledb") return "postgres";
  if (name === "redis" || name === "valkey") return "redis";
  if (name === "mongo") return "mongo";
  if (["nginx", "httpd", "caddy", "traefik", "ghost", "wordpress", "grafana", "nextcloud"].includes(name)) return "web";
  return null;
}

const guessed = detect(props.container.image);
const firstPort = props.container.ports?.find((p) => p.type === "tcp")?.privatePort ?? 80;
const isDb = (k: Kind): boolean => TEMPLATES[k].group === "Base de données";

// Sonde des outils du conteneur (lecture seule : simples tests de présence).
const probe = ref<Probe | null>(null);
const probing = ref(true);
const probeError = ref("");
const tools = computed<Tools | null>(() => (probe.value ? new Set(probe.value.tools) : null));

const form = reactive({
  kind: (guessed ?? "custom") as Kind,
  port: firstPort,
  test: guessed ? TEMPLATES[guessed].test(firstPort, null) : "",
  interval: "30s",
  timeout: "10s",
  retries: 5,
  startPeriod: guessed && isDb(guessed) ? "60s" : "30s",
});

onMounted(async () => {
  try {
    probe.value = await api<Probe>(`/api/v1/hosts/${props.hostId}/containers/${props.container.id}/tools`, { method: "POST" });
  } catch (err) {
    probeError.value = describeError(err);
  } finally {
    probing.value = false;
  }
});

// Changer de modèle (ou recevoir le résultat de la sonde) recalcule la commande ; la modifier à la main bascule sur « Personnalisé ».
watch(
  () => [form.kind, form.port, tools.value] as const,
  ([kind, port, t]) => {
    if (kind !== "custom") form.test = TEMPLATES[kind].test(port, t);
  },
);
watch(
  () => form.kind,
  (kind) => {
    if (isDb(kind)) form.startPeriod = "60s";
  },
);
const needsPort = computed(() => form.kind === "web" || form.kind === "tcp");

/** Aucun outil exploitable pour un test HTTP/TCP : il faudrait ajouter un outil à l'image. */
const noTool = computed(() => {
  const t = tools.value;
  if (!t || !needsPort.value) return false;
  return !["curl", "wget", "node", "python3", "python", "bash", "nc"].some((x) => t.has(x));
});

const step = ref<"form" | "diff">("form");
const before = ref("");
const after = ref("");
const message = ref("");
const error = ref("");
const busy = ref(false);

const payload = () => ({
  expectedRevision: props.revision,
  test: form.test.trim(),
  interval: form.interval.trim(),
  timeout: form.timeout.trim(),
  retries: Number(form.retries),
  startPeriod: form.startPeriod.trim(),
});
const url = () => `/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/healthcheck`;

async function preview() {
  error.value = "";
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
    const r = await api<ChangeResult>(url(), {
      method: "PATCH",
      body: JSON.stringify({ ...payload(), ...(message.value ? { message: message.value } : {}) }),
    });
    emit("saved", r.revision);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

const groups = ["Base de données", "Réseau", "Autre"];
const input = "rounded border border-slate-300 px-3 py-2";
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`Healthcheck du service ${service}`" class="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">Healthcheck de « {{ service }} »</h2>
          <p class="text-xs text-slate-500">Image {{ container.image }} · {{ step === "form" ? "1/2 Configuration" : "2/2 Différences du Compose" }}</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div v-if="step === 'form'" class="space-y-4 p-6 text-sm">
        <p v-if="probing" class="rounded bg-slate-100 p-3 text-slate-700">Recherche des outils disponibles dans le conteneur…</p>
        <template v-else-if="probe">
          <p v-if="!probe.shell" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
            Ce conteneur n'a pas de shell : un healthcheck par commande est impossible tel quel.
            <button class="ml-1 underline" @click="emit('customImage')">Créer une image personnalisée</button>
          </p>
          <p v-else class="rounded bg-slate-100 p-3 text-slate-700">
            Outils détectés dans le conteneur : <strong>{{ probe.tools.length ? probe.tools.join(", ") : "aucun des outils courants" }}</strong>. Le modèle utilise l'un d'eux quand c'est possible.
          </p>
        </template>
        <p v-else-if="probeError" class="rounded bg-slate-100 p-3 text-slate-700">Détection des outils impossible ({{ probeError }}) : la commande proposée n'est pas vérifiée, contrôlez-la.</p>

        <p v-if="noTool" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Aucun outil adapté (curl, wget, node, python, bash, nc) dans ce conteneur : le test sera toujours « en échec ».
          <button class="ml-1 underline" @click="emit('customImage')">Créer une image personnalisée avec l'outil nécessaire</button>
        </p>
        <p v-if="guessed" class="rounded bg-blue-50 p-3 text-blue-900">Modèle « {{ TEMPLATES[guessed].label }} » présélectionné d'après l'image. Vous pouvez le changer ou ajuster les paramètres.</p>
        <p v-else class="rounded bg-slate-100 p-3 text-slate-700">Image non reconnue : choisissez un modèle ou saisissez votre propre commande.</p>

        <label class="block">
          <span class="mb-1 block font-medium">Modèle</span>
          <select v-model="form.kind" :class="[input, 'w-full']">
            <optgroup v-for="g in groups" :key="g" :label="g">
              <option v-for="(t, k) in TEMPLATES" v-show="t.group === g" :key="k" :value="k">{{ t.label }}</option>
            </optgroup>
          </select>
        </label>

        <label v-if="needsPort" class="block">
          <span class="mb-1 block font-medium">Port dans le conteneur</span>
          <input v-model.number="form.port" type="number" min="1" max="65535" :class="[input, 'w-32']" />
        </label>

        <label class="block">
          <span class="mb-1 block font-medium">Commande de test (exécutée dans le conteneur)</span>
          <textarea v-model="form.test" rows="2" :class="[input, 'w-full font-mono text-xs']" @input="form.kind = 'custom'"></textarea>
          <span class="mt-1 block text-xs text-slate-500">Code de sortie 0 = sain. L'outil utilisé doit exister dans l'image, sinon le service sera toujours « en échec ».</span>
        </label>

        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <label><span class="mb-1 block font-medium">Intervalle</span><input v-model="form.interval" :class="[input, 'w-full']" /></label>
          <label><span class="mb-1 block font-medium">Expiration</span><input v-model="form.timeout" :class="[input, 'w-full']" /></label>
          <label><span class="mb-1 block font-medium">Essais</span><input v-model.number="form.retries" type="number" min="1" max="100" :class="[input, 'w-full']" /></label>
          <label><span class="mb-1 block font-medium">Démarrage</span><input v-model="form.startPeriod" :class="[input, 'w-full']" /></label>
        </div>
        <p class="text-xs text-slate-500">Durées au format 30s, 1m, 500ms. La période de démarrage laisse au service le temps de s'initialiser avant de compter les échecs.</p>
      </div>

      <div v-else class="space-y-3 p-6 text-sm">
        <DiffView :before="before" :after="after" />
        <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" :class="[input, 'w-full']" />
        <p class="text-xs text-slate-500">Une nouvelle révision sera enregistrée ; elle n'est pas déployée automatiquement.</p>
      </div>

      <p v-if="error" role="alert" class="px-6 text-sm text-red-700">{{ error }}</p>

      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="step === 'diff' ? (step = 'form') : emit('close')">{{ step === "diff" ? "Retour" : "Annuler" }}</button>
        <button v-if="step === 'form'" :disabled="busy || probing || !form.test.trim()" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="preview">Voir les différences</button>
        <button v-else :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
      </footer>
    </div>
  </div>
</template>
