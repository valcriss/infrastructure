<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api, describeError } from "../../api";
import CopyButton from "../../components/CopyButton.vue";
import DiffView from "../../components/DiffView.vue";
import PanelCard from "../../components/PanelCard.vue";
import TraefikDynamic from "../../components/TraefikDynamic.vue";

// Traefik (reverse proxy) : création d'une application préconfigurée, puis rappel des noms choisis.
interface Candidate { name: string; driver: string; usedBy: string[]; suggested: boolean }
interface HostOption { id: string; name: string; online: boolean; networks: Candidate[] | null; portConflicts: { port: number; container: string }[] }
interface Settings { stackId: string; hostId: string; httpEntryPoint: string; httpsEntryPoint: string; certResolver: string; network: string; production: boolean; email?: string; logLevel?: string }
interface Application { id: string; name: string; hostId: string; hostName: string | null; currentRevision: number; deployedRevision: number | null; deployed: boolean; healthcheck: boolean; managed: boolean }
interface State {
  settings: Settings | null;
  application: Application | { missing: true } | null;
  stackName: string;
  image: string;
  defaults: { httpEntryPoint: string; httpsEntryPoint: string; certResolver: string; networkName: string };
  hosts: HostOption[];
}
interface Preview { compose: string; files: Record<string, string> }
interface Adoption { equivalent: boolean; notes: string[]; compose: { before: string; after: string }; staticConfig: { before: string; after: string } }
const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];

const state = ref<State | null>(null);
const error = ref("");
const info = ref("");
const creating = ref(false);
const busy = ref(false);
const preview = ref<Preview | null>(null);

const form = reactive({
  hostId: "",
  email: "",
  production: false,
  httpEntryPoint: "web",
  httpsEntryPoint: "websecure",
  certResolver: "letsencrypt",
  networkMode: "create" as "create" | "existing",
  networkName: "traefik-public",
});

const field = "mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm";
const ghost = "rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50";

const host = computed(() => state.value?.hosts.find((h) => h.id === form.hostId) ?? null);
const candidates = computed(() => host.value?.networks ?? []);
const application = computed(() => (state.value?.application && !("missing" in state.value.application) ? state.value.application : null));
const missing = computed(() => !!state.value?.application && "missing" in state.value.application);

async function load() {
  try {
    state.value = await api<State>("/api/v1/settings/traefik");
    const d = state.value.defaults;
    if (!creating.value) Object.assign(form, { httpEntryPoint: d.httpEntryPoint, httpsEntryPoint: d.httpsEntryPoint, certResolver: d.certResolver, networkName: d.networkName });
    if (!form.hostId || !state.value.hosts.some((h) => h.id === form.hostId)) form.hostId = state.value.hosts[0]?.id ?? "";
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(load);

// Changer d'hôte ou de mode : on repart d'un choix cohérent (réseau suggéré, ou nom proposé pour un nouveau réseau).
watch([() => form.hostId, () => form.networkMode], () => {
  preview.value = null;
  if (form.networkMode === "existing") {
    const best = candidates.value.find((c) => c.suggested) ?? candidates.value[0];
    if (best) form.networkName = best.name;
  } else if (state.value) {
    form.networkName = state.value.defaults.networkName;
  }
});
watch(
  () => [form.email, form.production, form.httpEntryPoint, form.httpsEntryPoint, form.certResolver, form.networkName],
  () => (preview.value = null),
);

const payload = () => ({
  hostId: form.hostId,
  email: form.email.trim(),
  production: form.production,
  httpEntryPoint: form.httpEntryPoint.trim(),
  httpsEntryPoint: form.httpsEntryPoint.trim(),
  certResolver: form.certResolver.trim(),
  network: { mode: form.networkMode, name: form.networkName.trim() },
});

async function showPreview() {
  error.value = info.value = "";
  busy.value = true;
  try {
    preview.value = await api<Preview>("/api/v1/settings/traefik/preview", { method: "POST", body: JSON.stringify(payload()) });
  } catch (err) {
    preview.value = null;
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const snippetHost = ref("");
const snippet = ref("");
async function makeSnippet() {
  error.value = info.value = "";
  busy.value = true;
  try {
    snippet.value = (await api<{ snippet: string }>("/api/v1/settings/traefik/console-snippet", { method: "POST", body: JSON.stringify({ host: snippetHost.value.trim() }) })).snippet;
  } catch (err) {
    snippet.value = "";
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// Réglages d'une application gérée : brouillon rempli depuis l'état enregistré.
const opts = reactive({ email: "", production: false, logLevel: "INFO" });
function resetOptions() {
  const st = state.value?.settings;
  Object.assign(opts, { email: st?.email ?? "", production: st?.production ?? false, logLevel: st?.logLevel ?? "INFO" });
}
const optionsDirty = computed(() => {
  const st = state.value?.settings;
  return !!st && (opts.email.trim() !== (st.email ?? "") || opts.production !== st.production || opts.logLevel !== (st.logLevel ?? "INFO"));
});
watch(() => state.value?.settings, resetOptions, { immediate: true });

async function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function run(fn: () => Promise<void>) {
  error.value = info.value = "";
  busy.value = true;
  try {
    await fn();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const saveOptions = () => {
  if (!window.confirm("Enregistrer ces réglages ? Une nouvelle révision est créée ; redéployez ensuite l'application Traefik pour les appliquer (redémarrage bref de Traefik, les certificats déjà obtenus sont conservés).")) return;
  return run(async () => {
    await post("/api/v1/settings/traefik/options", { email: opts.email.trim(), production: opts.production, logLevel: opts.logLevel });
    info.value = "Réglages enregistrés dans une nouvelle révision. Redéployez l'application Traefik pour les appliquer.";
    await load();
  });
};
const detach = () => {
  if (!window.confirm("Détacher l'application de la gestion automatique ? Elle devient modifiable à la main (Compose, traefik.yml), et la console ne la régénère plus.")) return;
  return run(async () => {
    await post("/api/v1/settings/traefik/detach");
    info.value = "Application détachée : elle se modifie désormais comme les autres.";
    await load();
  });
};
const addHealthcheck = () => {
  const text = application.value?.managed
    ? "Régénérer l'application pour y ajouter le healthcheck ? Vos réglages et la configuration dynamique sont conservés. Une nouvelle révision est créée ; redéployez ensuite l'application (redémarrage bref de Traefik)."
    : "Ajouter le healthcheck à l'application Traefik ? Le Compose reçoit un healthcheck et traefik.yml la ligne « ping » ; vos autres réglages sont conservés. Une nouvelle révision est créée ; redéployez ensuite l'application (redémarrage bref de Traefik).";
  if (!window.confirm(text)) return;
  return run(async () => {
    const r = await post<{ changed: boolean; notes: string[] }>("/api/v1/settings/traefik/healthcheck");
    info.value = (r.changed ? "Healthcheck ajouté dans une nouvelle révision. Redéployez l'application Traefik pour l'appliquer." : "Aucune modification.") + (r.notes.length ? " " + r.notes.join(" ") : "");
    await load();
  });
};

// Prise en charge d'une application existante : aperçu de ce qui changerait, puis confirmation.
const adoption = ref<Adoption | null>(null);
const previewAdoption = () => run(async () => { adoption.value = await post<Adoption>("/api/v1/settings/traefik/adopt/preview"); });
const adopt = () => run(async () => {
  const r = await post<{ revision: number; changed: boolean; notes: string[] }>("/api/v1/settings/traefik/adopt", { confirm: true });
  adoption.value = null;
  info.value = r.changed
    ? "Application prise en charge. Une nouvelle révision a été créée : relisez-la puis redéployez."
    : "Application prise en charge : sa configuration correspondait déjà, rien à redéployer.";
  if (r.notes.length) info.value += " " + r.notes.join(" ");
  await load();
});

async function create() {
  error.value = info.value = "";
  busy.value = true;
  try {
    await api("/api/v1/settings/traefik/application", { method: "POST", body: JSON.stringify(payload()) });
    creating.value = false;
    preview.value = null;
    info.value = "Application Traefik créée (révision 1, non déployée). Ouvrez-la, relisez les fichiers, puis déployez.";
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <p v-if="!state && !error" class="text-slate-500">Chargement…</p>

    <template v-if="application && state?.settings">
    <PanelCard title="Application Traefik" icon="route" subtitle="Reverse proxy créé par la console">
      <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt class="text-xs text-slate-500">Application</dt><dd><RouterLink :to="`/stacks/${application.id}`" class="text-blue-600 underline">{{ application.name }}</RouterLink> · hôte {{ application.hostName ?? "inconnu" }}</dd></div>
        <div>
          <dt class="text-xs text-slate-500">État</dt>
          <dd>
            <span v-if="application.deployed" class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">déployée (révision {{ application.deployedRevision }})</span>
            <span v-else class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">pas encore déployée</span>
          </dd>
        </div>
        <div><dt class="text-xs text-slate-500">Entrypoints</dt><dd class="font-mono">{{ state.settings.httpEntryPoint }} (80) · {{ state.settings.httpsEntryPoint }} (443)</dd></div>
        <div><dt class="text-xs text-slate-500">Résolveur de certificats</dt><dd class="font-mono">{{ state.settings.certResolver }} <span class="font-sans text-xs text-slate-500">({{ state.settings.production ? "production" : "autorité de test" }})</span></dd></div>
        <div><dt class="text-xs text-slate-500">Réseau partagé</dt><dd class="font-mono">{{ state.settings.network }}</dd></div>
        <div><dt class="text-xs text-slate-500">Image</dt><dd class="font-mono">{{ state.image }}</dd></div>
      </dl>
      <p v-if="!application.deployed" class="mt-3 text-sm text-slate-600">Rien n'est déployé tant que vous ne l'avez pas demandé : ouvrez l'application, relisez ses fichiers, puis déployez.</p>
      <p v-if="!application.healthcheck" role="note" class="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900">
        Cette application n'a pas de healthcheck : un Traefik bloqué mais toujours « en marche » ne serait pas signalé.
        <button :class="ghost" class="ml-2" :disabled="busy" @click="addHealthcheck">Ajouter le healthcheck</button>
      </p>
      <p v-if="state.settings.production === false" class="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900">
        Les certificats viennent de l'autorité de test de Let's Encrypt : les navigateurs les refusent.
        <template v-if="application.managed">Passez en production dans les réglages ci-dessous, puis redéployez.</template>
        <template v-else>Pour passer en production, confiez l'application à la console (ci-dessous) ou retirez la ligne <code>caServer</code> de <code>traefik.yml</code>, puis redéployez.</template>
      </p>

      <div v-if="application.managed" class="mt-4 border-t border-slate-100 pt-4">
        <h3 class="text-sm font-semibold">Réglages</h3>
        <p class="mt-1 text-xs text-slate-500">Application générée et entretenue par la console : son Compose et <code>traefik.yml</code> viennent de ces réglages. La configuration dynamique (middlewares, routes) est conservée.</p>
        <form class="mt-3 space-y-3 text-sm" @submit.prevent="saveOptions">
          <label class="block max-w-md">
            <span class="font-medium">Adresse e-mail Let's Encrypt</span>
            <input v-model="opts.email" type="email" required autocomplete="off" :class="field" />
          </label>
          <fieldset>
            <legend class="font-medium">Certificats</legend>
            <label class="mt-1 flex items-start gap-2"><input v-model="opts.production" type="radio" :value="false" class="mt-1" /><span>Autorité de test <span class="block text-xs text-slate-500">Certificats non reconnus par les navigateurs, sans limite de débit.</span></span></label>
            <label class="mt-1 flex items-start gap-2"><input v-model="opts.production" type="radio" :value="true" class="mt-1" /><span>Production <span class="block text-xs text-slate-500">Certificats valides ; Let's Encrypt limite les demandes en cas d'erreurs répétées.</span></span></label>
          </fieldset>
          <label class="block max-w-xs">
            <span class="font-medium">Niveau de journalisation</span>
            <select v-model="opts.logLevel" :class="field"><option v-for="l in LOG_LEVELS" :key="l" :value="l">{{ l }}</option></select>
          </label>
          <p class="text-xs text-slate-500">Les entrypoints (<span class="font-mono">{{ state.settings.httpEntryPoint }}</span>, <span class="font-mono">{{ state.settings.httpsEntryPoint }}</span>), le résolveur et le réseau ne se modifient pas ici : les applications exposées y font référence.</p>
          <div class="flex flex-wrap items-center gap-2">
            <button class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy || !optionsDirty || !opts.email.trim()">Enregistrer</button>
            <button type="button" :class="ghost" :disabled="busy || !optionsDirty" @click="resetOptions">Annuler</button>
            <button type="button" :class="ghost" :disabled="busy" @click="detach">Détacher de la gestion automatique</button>
          </div>
        </form>
      </div>

      <div v-else class="mt-4 border-t border-slate-100 pt-4">
        <h3 class="text-sm font-semibold">Gestion par la console</h3>
        <p class="mt-1 text-sm text-slate-600">
          Cette application se modifie à la main. La console peut la prendre en charge : les réglages (certificats, e-mail, journalisation) se changent alors ici, sans éditer de fichier.
          Vous relisez d'abord ce qui changerait ; la configuration dynamique et la version de l'image sont conservées, et vous pouvez la détacher ensuite.
        </p>
        <button class="mt-2" :class="ghost" :disabled="busy" @click="previewAdoption">Confier à la console…</button>
        <div v-if="adoption" class="mt-3 space-y-3 rounded border border-slate-200 p-3 text-sm">
          <p v-if="adoption.equivalent" role="status" class="text-green-700">La configuration actuelle correspond déjà à ce que la console générerait : la prise en charge ne change rien.</p>
          <template v-else>
            <p role="note" class="rounded bg-amber-50 p-2 text-xs text-amber-900">Votre configuration diffère de ce que la console génère : la prise en charge la remplace par la version « après » ci-dessous (une nouvelle révision, non déployée). Les modifications faites à la main dans ces deux fichiers seront perdues ; vous pouvez détacher l'application ensuite pour les refaire.</p>
            <div><p class="mb-1 text-xs font-medium">docker-compose.yml</p><DiffView :before="adoption.compose.before" :after="adoption.compose.after" /></div>
            <div><p class="mb-1 text-xs font-medium">traefik.yml</p><DiffView :before="adoption.staticConfig.before" :after="adoption.staticConfig.after" /></div>
          </template>
          <p v-for="n in adoption.notes" :key="n" class="text-xs text-amber-800">{{ n }}</p>
          <div class="flex flex-wrap gap-2">
            <button class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy" @click="adopt">{{ adoption.equivalent ? "Confier à la console" : "Remplacer et confier à la console" }}</button>
            <button :class="ghost" :disabled="busy" @click="adoption = null">Annuler</button>
          </div>
        </div>
      </div>

      <div class="mt-4 border-t border-slate-100 pt-4">
        <h3 class="text-sm font-semibold">Exposer la console elle-même</h3>
        <p class="mt-1 text-sm text-slate-600">
          La console ne se gère pas elle-même : générez l'extrait à ajouter au service « console » de son <code>docker-compose.yml</code>, puis redéployez la console.
          Le tunnel SSH reste utilisable pendant ce temps.
        </p>
        <form class="mt-2 flex flex-wrap items-end gap-2 text-sm" @submit.prevent="makeSnippet">
          <label>
            <span class="block text-xs font-medium">Nom de domaine de la console</span>
            <input v-model="snippetHost" required placeholder="console.exemple.fr" aria-label="Nom de domaine de la console" class="mt-1 w-64 rounded border border-slate-300 bg-white px-3 py-2 font-mono text-xs" />
          </label>
          <button :class="ghost" :disabled="busy || !snippetHost.trim()">Générer l'extrait</button>
        </form>
        <div v-if="snippet" class="mt-3">
          <div class="mb-1 flex justify-end"><CopyButton :text="snippet" label="Copier l'extrait" /></div>
          <pre class="overflow-x-auto rounded border border-slate-200 bg-slate-50 p-3 text-xs">{{ snippet }}</pre>
        </div>
      </div>
    </PanelCard>

    <TraefikDynamic />
    </template>

    <template v-else-if="state">
      <p v-if="missing" role="note" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        L'application Traefik configurée a été supprimée. Vous pouvez en créer une nouvelle.
      </p>
      <PanelCard title="Traefik" icon="route" subtitle="Reverse proxy HTTPS pour les applications de la console">
        <p class="text-sm text-slate-600">
          Aucune application Traefik. La console peut en créer une préconfigurée (entrypoints 80 et 443, redirection vers HTTPS, certificats Let's Encrypt par le port 80) :
          vous relisez les fichiers générés, puis vous la déployez comme n'importe quelle application.
        </p>
        <p v-if="state.hosts.length === 0" class="mt-3 text-sm text-slate-500">Aucun hôte : enrôlez d'abord un agent.</p>
        <button v-else-if="!creating" class="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" @click="creating = true; load()">
          <FaIcon :icon="['fas', 'plus']" /> Ajouter une application Traefik
        </button>
      </PanelCard>

      <PanelCard v-if="creating && state.hosts.length" title="Nouvelle application Traefik" icon="plus" subtitle="Les noms choisis ici sont proposés ensuite pour exposer les applications">
        <form class="space-y-4 text-sm" @submit.prevent="create">
          <div class="grid gap-4 md:grid-cols-2">
            <label>
              <span class="font-medium">Hôte</span>
              <select v-model="form.hostId" :class="field">
                <option v-for="h in state.hosts" :key="h.id" :value="h.id">{{ h.name }}{{ h.online ? "" : " (hors ligne)" }}</option>
              </select>
            </label>
            <label>
              <span class="font-medium">Adresse e-mail Let's Encrypt</span>
              <input v-model="form.email" type="email" required autocomplete="off" placeholder="admin@exemple.fr" :class="field" />
              <span class="text-xs text-slate-500">Reçoit les avis d'expiration des certificats.</span>
            </label>
          </div>

          <p v-if="host && host.portConflicts.length" role="alert" class="rounded border border-red-300 bg-red-50 p-2 text-red-800">
            Cet hôte publie déjà
            <template v-for="(c, i) in host.portConflicts" :key="c.port + c.container"><template v-if="i">, </template>le port {{ c.port }} ({{ c.container }})</template> :
            Traefik ne pourra pas démarrer tant que ces ports sont occupés.
          </p>

          <fieldset>
            <legend class="font-medium">Certificats</legend>
            <label class="mt-1 flex items-start gap-2"><input v-model="form.production" type="radio" :value="false" class="mt-1" /><span>Autorité de test (recommandé pour commencer) <span class="block text-xs text-slate-500">Certificats non reconnus par les navigateurs, sans limite de débit. Passez en production une fois le routage vérifié.</span></span></label>
            <label class="mt-1 flex items-start gap-2"><input v-model="form.production" type="radio" :value="true" class="mt-1" /><span>Production <span class="block text-xs text-slate-500">Certificats valides, mais Let's Encrypt limite le nombre de demandes en cas d'erreurs répétées.</span></span></label>
          </fieldset>

          <div class="grid gap-4 md:grid-cols-3">
            <label><span class="font-medium">Entrypoint HTTP</span><input v-model="form.httpEntryPoint" required :class="field" /></label>
            <label><span class="font-medium">Entrypoint HTTPS</span><input v-model="form.httpsEntryPoint" required :class="field" /></label>
            <label><span class="font-medium">Résolveur de certificats</span><input v-model="form.certResolver" required :class="field" /></label>
          </div>

          <fieldset>
            <legend class="font-medium">Réseau partagé</legend>
            <p class="text-xs text-slate-500">Traefik et les applications qu'il expose doivent être sur le même réseau Docker.</p>
            <p v-if="host && host.networks === null" class="mt-1 text-xs text-amber-800">L'agent de cet hôte ne remonte pas la liste des réseaux (mettez-le à jour) : le choix ne peut pas être vérifié.</p>
            <label class="mt-2 flex items-start gap-2">
              <input v-model="form.networkMode" type="radio" value="existing" class="mt-1" :disabled="host?.networks !== null && candidates.length === 0" />
              <span>Utiliser un réseau existant <span v-if="host?.networks && candidates.length === 0" class="text-xs text-slate-500">(aucun réseau candidat sur cet hôte)</span></span>
            </label>
            <div v-if="form.networkMode === 'existing'" class="ml-6 mt-1">
              <select v-if="candidates.length" v-model="form.networkName" :class="field" aria-label="Réseau existant">
                <option v-for="c in candidates" :key="c.name" :value="c.name">{{ c.name }}{{ c.suggested ? " (suggéré)" : "" }}{{ c.usedBy.length ? ` — ${c.usedBy.join(", ")}` : " — inutilisé" }}</option>
              </select>
              <input v-else v-model="form.networkName" :class="field" aria-label="Nom du réseau existant" />
              <p class="mt-1 text-xs text-slate-500">Traefik pourra joindre toutes les applications de ce réseau : vérifiez qu'il ne relie que celles que vous voulez exposer.</p>
            </div>
            <label class="mt-2 flex items-start gap-2"><input v-model="form.networkMode" type="radio" value="create" class="mt-1" /><span>Créer un nouveau réseau</span></label>
            <div v-if="form.networkMode === 'create'" class="ml-6 mt-1"><input v-model="form.networkName" :class="field" aria-label="Nom du nouveau réseau" /></div>
          </fieldset>

          <p role="note" class="rounded bg-slate-50 p-2 text-xs text-slate-600">
            Traefik lit le socket Docker de l'hôte (en lecture seule) pour découvrir les conteneurs : c'est un accès étendu au démon Docker. Le tableau de bord de Traefik reste désactivé.
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <button type="button" :class="ghost" :disabled="busy || !form.email" @click="showPreview">Aperçu des fichiers</button>
            <button class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy || !form.email">Créer l'application</button>
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
