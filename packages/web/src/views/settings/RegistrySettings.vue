<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, describeError } from "../../api";
import CopyButton from "../../components/CopyButton.vue";
import PanelCard from "../../components/PanelCard.vue";
import RegistryImages from "../../components/RegistryImages.vue";

// Registre d'images privé : application générée par la console, placée derrière Traefik.
interface Settings { stackId: string; hostId: string; host: string; entryPoint: string; certResolver: string; network: string }
interface Application { id: string; name: string; hostId: string; hostName: string | null; currentRevision: number; deployedRevision: number | null; deployed: boolean; managed: boolean }
type TraefikInfo = { available: true; hostId: string; hostName: string | null; deployed: boolean; production: boolean; entryPoint: string; certResolver: string; network: string } | { available: false; reason: string };
interface State {
  settings: Settings | null;
  application: Application | { missing: true } | null;
  hasPassword: boolean;
  stackName: string;
  image: string;
  username: string;
  traefik: TraefikInfo;
}
interface Preview { compose: string; files: Record<string, string> }
interface Step { ok: boolean; detail: string }
interface Probe { dns: Step; tls: Step; anonymous: Step; authenticated: Step; ready: boolean }

const emit = defineEmits<{ "go-traefik": [] }>();

const state = ref<State | null>(null);
const error = ref("");
const info = ref("");
const creating = ref(false);
const busy = ref(false);
const host = ref("");
const preview = ref<Preview | null>(null);
const probe = ref<Probe | null>(null);
const credentials = ref<{ registry: string; username: string; password: string } | null>(null);

const field = "mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm";
const ghost = "rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50";
const primary = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";

const application = computed(() => (state.value?.application && !("missing" in state.value.application) ? state.value.application : null));
const missing = computed(() => !!state.value?.application && "missing" in state.value.application);
const traefik = computed(() => state.value?.traefik ?? null);

async function load() {
  try {
    state.value = await api<State>("/api/v1/settings/registry");
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(load);
watch(host, () => (preview.value = null));

async function run<T>(fn: () => Promise<T>, onOk?: (r: T) => void) {
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await fn();
    onOk?.(r);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const body = () => JSON.stringify({ host: host.value.trim() });
const showPreview = () => run(() => api<Preview>("/api/v1/settings/registry/preview", { method: "POST", body: body() }), (r) => (preview.value = r));
const create = () =>
  run(
    () => api("/api/v1/settings/registry/application", { method: "POST", body: body() }),
    async () => {
      creating.value = false;
      preview.value = null;
      info.value = "Application registry créée (révision 1, non déployée). Ouvrez-la, relisez les fichiers, puis déployez.";
      await load();
    },
  );
const test = () => run(() => api<Probe>("/api/v1/settings/registry/test", { method: "POST" }), (r) => (probe.value = r));
const reveal = () => run(() => api<{ registry: string; username: string; password: string }>("/api/v1/settings/registry/credentials", { method: "POST" }), (r) => (credentials.value = r));
function rotate() {
  if (!window.confirm("Renouveler le mot de passe ? Une nouvelle révision est créée : tant que vous n'avez pas redéployé l'application registry, les accès échouent. Les hôtes connectés à la main devront se reconnecter.")) return;
  return run(
    () => api("/api/v1/settings/registry/rotate", { method: "POST" }),
    async () => {
      credentials.value = null;
      probe.value = null;
      info.value = "Nouveau mot de passe enregistré dans une nouvelle révision. Redéployez l'application registry pour l'appliquer.";
      await load();
    },
  );
}
function detach() {
  if (!window.confirm("Détacher l'application de la gestion automatique ? Elle devient modifiable à la main, et la console ne renouvellera plus son mot de passe.")) return;
  return run(
    () => api("/api/v1/settings/registry/detach", { method: "POST" }),
    async () => {
      info.value = "Application détachée : elle se modifie désormais comme les autres.";
      await load();
    },
  );
}

const loginCommand = computed(() => (credentials.value ? `docker login ${credentials.value.registry} -u ${credentials.value.username}` : ""));
const stepLabels: [keyof Omit<Probe, "ready">, string][] = [
  ["dns", "Nom de domaine"],
  ["tls", "Certificat reconnu"],
  ["anonymous", "Accès anonyme refusé"],
  ["authenticated", "Identifiants acceptés"],
];
</script>

<template>
  <div class="space-y-4">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <p v-if="!state && !error" class="text-slate-500">Chargement…</p>

    <template v-if="state && traefik && !traefik.available">
      <PanelCard title="Registry" icon="box" subtitle="Registre d'images privé, servi en HTTPS par Traefik">
        <p class="text-sm text-slate-600">{{ traefik.reason }}</p>
        <button class="mt-3" :class="ghost" @click="emit('go-traefik')">Ouvrir les paramètres Traefik</button>
      </PanelCard>
    </template>

    <template v-else-if="state && application && state.settings">
      <PanelCard title="Application registry" icon="box" subtitle="Registre d'images privé créé par la console">
        <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt class="text-xs text-slate-500">Adresse</dt><dd class="font-mono">{{ state.settings.host }}</dd></div>
          <div><dt class="text-xs text-slate-500">Application</dt><dd><RouterLink :to="`/stacks/${application.id}`" class="text-blue-600 underline">{{ application.name }}</RouterLink> · hôte {{ application.hostName ?? "inconnu" }}</dd></div>
          <div>
            <dt class="text-xs text-slate-500">État</dt>
            <dd>
              <span v-if="application.deployed" class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">déployée (révision {{ application.deployedRevision }})</span>
              <span v-else class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">pas encore déployée</span>
              <span v-if="application.deployed && application.deployedRevision !== application.currentRevision" class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">révision {{ application.currentRevision }} à déployer</span>
            </dd>
          </div>
          <div><dt class="text-xs text-slate-500">Gestion</dt><dd>{{ application.managed ? "automatique (contenu protégé)" : "détachée (modifiable à la main)" }}</dd></div>
          <div><dt class="text-xs text-slate-500">Compte</dt><dd class="font-mono">{{ state.username }} <span class="font-sans text-xs text-slate-500">({{ state.hasPassword ? "mot de passe enregistré" : "mot de passe manquant" }})</span></dd></div>
          <div><dt class="text-xs text-slate-500">Image</dt><dd class="font-mono">{{ state.image }}</dd></div>
        </dl>
        <p v-if="!application.deployed" class="mt-3 text-sm text-slate-600">Rien n'est déployé tant que vous ne l'avez pas demandé : ouvrez l'application, relisez ses fichiers, puis déployez.</p>
        <p v-if="traefik && traefik.available && !traefik.production" role="note" class="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900">
          Traefik utilise l'autorité de test de Let's Encrypt : les démons Docker refuseront ce certificat. Passez Traefik en production (retirez <code>caServer</code> de <code>traefik.yml</code>) avant d'utiliser le registre.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <button :class="primary" :disabled="busy || !application.deployed" :title="application.deployed ? '' : 'Déployez d\'abord l\'application'" @click="test">Tester l'accès</button>
          <button :class="ghost" :disabled="busy || !state.hasPassword" @click="reveal">Afficher les identifiants</button>
          <button v-if="application.managed" :class="ghost" :disabled="busy" @click="rotate">Renouveler le mot de passe</button>
          <button v-if="application.managed" :class="ghost" :disabled="busy" @click="detach">Détacher de la gestion automatique</button>
        </div>

        <ul v-if="probe" class="mt-4 space-y-1 text-sm" aria-label="Résultat du test">
          <li v-for="[key, label] in stepLabels" :key="key" class="flex items-start gap-2">
            <FaIcon :icon="['fas', probe[key].ok ? 'circle-check' : 'circle-xmark']" :class="probe[key].ok ? 'text-green-600' : 'text-red-600'" class="mt-0.5" />
            <span><span class="font-medium">{{ label }}</span> <span class="text-slate-600">— {{ probe[key].detail }}</span></span>
          </li>
          <li class="pt-1 font-medium" :class="probe.ready ? 'text-green-700' : 'text-red-700'">{{ probe.ready ? "Le registre est prêt : les hôtes peuvent s'y connecter." : "Le registre n'est pas prêt." }}</li>
        </ul>

        <div v-if="credentials" class="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <p class="text-xs text-slate-500">À ne copier que là où c'est nécessaire (un « docker login » à la main). La console le transmet seule à ses propres déploiements.</p>
          <p class="mt-2">Identifiant : <code>{{ credentials.username }}</code></p>
          <p class="mt-1">Mot de passe : <code class="break-all">{{ credentials.password }}</code><CopyButton :text="credentials.password" label="Copier le mot de passe" /></p>
          <p class="mt-2 font-mono text-xs">{{ loginCommand }}<CopyButton :text="loginCommand" label="Copier la commande" /></p>
          <button class="mt-2" :class="ghost" @click="credentials = null">Masquer</button>
        </div>
      </PanelCard>
      <RegistryImages v-if="application.deployed" />
    </template>

    <template v-else-if="state && traefik && traefik.available">
      <p v-if="missing" role="note" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        L'application registry configurée a été supprimée. Vous pouvez en créer une nouvelle (ses images stockées ne sont plus disponibles si son volume a été supprimé).
      </p>
      <PanelCard title="Registry" icon="box" subtitle="Registre d'images privé, servi en HTTPS par Traefik">
        <p class="text-sm text-slate-600">
          Aucune application registry. La console peut en créer une préconfigurée (registre OCI protégé par un mot de passe généré, certificat Let's Encrypt par Traefik, volume dédié) :
          vous relisez les fichiers générés, puis vous la déployez. Le mot de passe est enregistré chiffré et transmis seul aux déploiements qui tirent des images de ce registre.
        </p>
        <p v-if="!traefik.deployed" class="mt-2 text-sm text-amber-800">L'application Traefik n'est pas encore déployée : le registre ne sera joignable qu'après son déploiement.</p>
        <button v-if="!creating" class="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" @click="creating = true">
          <FaIcon :icon="['fas', 'plus']" /> Ajouter une application registry
        </button>
      </PanelCard>

      <PanelCard v-if="creating" title="Nouvelle application registry" icon="plus" subtitle="Hébergée sur l'hôte de Traefik, derrière ses entrypoints et son résolveur de certificats">
        <form class="space-y-4 text-sm" @submit.prevent="create">
          <label class="block">
            <span class="font-medium">Nom de domaine du registre</span>
            <input v-model="host" required placeholder="registry.exemple.fr" autocomplete="off" :class="field" class="font-mono" />
            <span class="text-xs text-slate-500">Doit pointer vers l'hôte « {{ traefik.hostName ?? "de Traefik" }} » (ports 80 et 443 joignables : Let's Encrypt valide le domaine par le port 80).</span>
          </label>
          <p v-if="!traefik.production" role="note" class="rounded bg-amber-50 p-2 text-xs text-amber-900">
            Traefik utilise l'autorité de test de Let's Encrypt : le registre sera créé, mais les démons Docker refuseront son certificat tant que Traefik n'est pas en production.
          </p>
          <p role="note" class="rounded bg-slate-50 p-2 text-xs text-slate-600">
            L'application créée est protégée : son contenu ne se modifie plus à la main (renouvellement du mot de passe depuis cette page). Elle peut être détachée de la gestion automatique ensuite.
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" :class="ghost" :disabled="busy || !host.trim()" @click="showPreview">Aperçu des fichiers</button>
            <button :class="primary" :disabled="busy || !host.trim()">Créer l'application</button>
            <button type="button" :class="ghost" :disabled="busy" @click="creating = false; preview = null">Annuler</button>
          </div>
          <div v-if="preview" class="space-y-2">
            <details open class="rounded border border-slate-200"><summary class="cursor-pointer px-3 py-1.5 font-medium">docker-compose.yml</summary><pre class="overflow-x-auto border-t border-slate-200 bg-slate-50 p-3 text-xs">{{ preview.compose }}</pre></details>
            <details v-for="(content, path) in preview.files" :key="path" class="rounded border border-slate-200"><summary class="cursor-pointer px-3 py-1.5 font-medium">{{ path }}</summary><pre class="overflow-x-auto border-t border-slate-200 bg-slate-50 p-3 text-xs">{{ content }}</pre></details>
          </div>
        </form>
      </PanelCard>
    </template>
  </div>
</template>
