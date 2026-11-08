<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api, describeError, type ChangeResult, type Container } from "../api";
import DiffView from "./DiffView.vue";

// Ajout d'un healthcheck à un service : choix du modèle et des paramètres, aperçu du diff Compose, puis enregistrement d'une révision.
const props = defineProps<{ stackId: string; revision: number; service: string; container: Container }>();
const emit = defineEmits<{ close: []; saved: [revision: number] }>();

type Kind = "mysql" | "mariadb" | "postgres" | "redis" | "mongo" | "web" | "tcp" | "custom";

const TEMPLATES: Record<Kind, { label: string; group: string; test: (port: number) => string }> = {
  mysql: { label: "MySQL", group: "Base de données", test: () => "mysqladmin ping -h 127.0.0.1 --silent" },
  mariadb: { label: "MariaDB", group: "Base de données", test: () => "mariadb-admin ping -h 127.0.0.1 --silent || mysqladmin ping -h 127.0.0.1 --silent" },
  postgres: { label: "PostgreSQL", group: "Base de données", test: () => "pg_isready -h 127.0.0.1" },
  redis: { label: "Redis / Valkey", group: "Base de données", test: () => "redis-cli ping | grep -q PONG" },
  mongo: { label: "MongoDB", group: "Base de données", test: () => "mongosh --quiet --eval \"db.adminCommand('ping').ok\" | grep -q 1" },
  web: {
    label: "Web (HTTP)",
    group: "Réseau",
    test: (p) => `wget -q -O /dev/null http://127.0.0.1:${p}/ || curl -fsS -o /dev/null http://127.0.0.1:${p}/`,
  },
  tcp: { label: "Port TCP ouvert", group: "Réseau", test: (p) => `nc -z 127.0.0.1 ${p}` },
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

const form = reactive({
  kind: (guessed ?? "custom") as Kind,
  port: firstPort,
  test: guessed ? TEMPLATES[guessed].test(firstPort) : "",
  interval: "30s",
  timeout: "10s",
  retries: 5,
  startPeriod: isDbInitial(guessed) ? "60s" : "30s",
});
function isDbInitial(k: Kind | null): boolean {
  return k !== null && TEMPLATES[k].group === "Base de données";
}

// Changer de modèle recalcule la commande ; la modifier à la main bascule sur « Personnalisé ».
watch(
  () => [form.kind, form.port] as const,
  ([kind, port]) => {
    if (kind !== "custom") form.test = TEMPLATES[kind].test(port);
    form.startPeriod = isDb(kind) ? "60s" : form.startPeriod;
  },
);
const needsPort = computed(() => form.kind === "web" || form.kind === "tcp");

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
          <span class="mt-1 block text-xs text-slate-500">Code de sortie 0 = sain. L'outil utilisé (wget, curl, nc…) doit exister dans l'image, sinon le service sera toujours « en échec ».</span>
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
        <button v-if="step === 'form'" :disabled="busy || !form.test.trim()" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="preview">Voir les différences</button>
        <button v-else :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
      </footer>
    </div>
  </div>
</template>
