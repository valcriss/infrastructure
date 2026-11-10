<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, describeError } from "../api";
import { useSession } from "../stores/session";
import PanelCard from "./PanelCard.vue";
import TraefikDynamicDialog, { type MiddlewareItem, type RouteItem } from "./TraefikDynamicDialog.vue";

// Configuration dynamique de Traefik (dynamic/dynamic.yml) : middlewares et routes vers des services d'autres hôtes.
// Chaque modification devient une révision de l'application Traefik, déployée à la demande.
interface State {
  available: boolean;
  reason?: string;
  stack?: { id: string; name: string };
  revision?: number;
  path?: string;
  fileMissing?: boolean;
  sensitive?: boolean;
  parseError?: string | null;
  middlewares: MiddlewareItem[];
  routes: RouteItem[];
}

const session = useSession();
const state = ref<State | null>(null);
const error = ref("");
const info = ref("");
const target = ref<{ mode: "middleware" | "route"; item: MiddlewareItem | RouteItem | null; remove: boolean } | null>(null);

const middlewareNames = computed(() => state.value?.middlewares.map((m) => m.name) ?? []);
const canEdit = computed(() => session.isAdmin && !state.value?.parseError);

async function load() {
  try {
    state.value = await api<State>("/api/v1/settings/traefik/dynamic");
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(load);

function onSaved(revision: number, sensitive: boolean) {
  target.value = null;
  info.value = `Révision ${revision} de l'application Traefik enregistrée${sensitive ? " (fichier marqué sensible : chiffré dans la sauvegarde Git)" : ""}. Elle n'est pas déployée : ouvrez l'application Traefik et déployez-la pour l'appliquer.`;
  void load();
}

const TYPE_LABEL: Record<string, string> = {
  ipAllowList: "adresses autorisées",
  basicAuth: "mot de passe",
  headers: "en-têtes",
  rateLimit: "limite de débit",
  compress: "compression",
  stripPrefix: "préfixe retiré",
};
const ghost = "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100";
const used = (m: MiddlewareItem): string[] => [...m.usedBy.routes.map((r) => `route ${r}`), ...m.usedBy.applications.map((a) => `application ${a}`)];
</script>

<template>
  <PanelCard title="Configuration dynamique" icon="sliders" subtitle="Middlewares et routes vers des services d'autres hôtes (dynamic/dynamic.yml)">
    <p v-if="error" role="alert" class="mb-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="mb-2 text-sm text-green-700">{{ info }}</p>
    <p v-if="!state && !error" class="text-sm text-slate-500">Chargement…</p>
    <p v-else-if="state && !state.available" class="text-sm text-slate-500">{{ state.reason }}</p>

    <template v-else-if="state">
      <p v-if="state.parseError" role="alert" class="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
        Le fichier <code>{{ state.path }}</code> n'est pas un YAML valide ({{ state.parseError }}). Corrigez-le dans l'onglet Fichiers de l'application Traefik avant d'utiliser l'assistant.
      </p>
      <p v-else-if="state.fileMissing" class="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">Le fichier <code>{{ state.path }}</code> n'existe pas : il sera créé à la première modification.</p>

      <section aria-label="Middlewares">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Middlewares</h3>
          <button v-if="canEdit" :class="ghost" @click="target = { mode: 'middleware', item: null, remove: false }">Ajouter un middleware</button>
        </div>
        <p v-if="state.middlewares.length === 0" class="mt-1 text-sm text-slate-500">Aucun middleware. Ils s'appliquent ensuite aux routes et aux applications (<code>nom@file</code>).</p>
        <ul v-else class="mt-1 divide-y divide-slate-100 text-sm">
          <li v-for="m in state.middlewares" :key="m.name" class="flex flex-wrap items-center justify-between gap-2 py-2">
            <div class="min-w-0">
              <span class="font-mono font-medium">{{ m.name }}</span>
              <span class="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{{ (m.type && TYPE_LABEL[m.type]) || m.type || "inconnu" }}</span>
              <p class="text-xs text-slate-500">{{ m.summary }}</p>
              <p v-if="used(m).length" class="text-xs text-slate-400">Utilisé par : {{ used(m).join(", ") }}</p>
            </div>
            <div v-if="canEdit" class="flex gap-1">
              <button v-if="m.spec" :class="ghost" @click="target = { mode: 'middleware', item: m, remove: false }">Modifier</button>
              <button :class="[ghost, 'text-red-700']" @click="target = { mode: 'middleware', item: m, remove: true }">Supprimer</button>
            </div>
          </li>
        </ul>
      </section>

      <section aria-label="Routes" class="mt-5 border-t border-slate-100 pt-4">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Routes vers d'autres hôtes</h3>
          <button v-if="canEdit" :class="ghost" @click="target = { mode: 'route', item: null, remove: false }">Ajouter une route</button>
        </div>
        <p v-if="state.routes.length === 0" class="mt-1 text-sm text-slate-500">Aucune route. Le fournisseur Docker de Traefik ne voit que les conteneurs de son hôte : une route ici envoie un domaine vers une adresse d'un autre serveur.</p>
        <ul v-else class="mt-1 divide-y divide-slate-100 text-sm">
          <li v-for="r in state.routes" :key="r.name" class="flex flex-wrap items-center justify-between gap-2 py-2">
            <div class="min-w-0">
              <span class="font-mono font-medium">{{ r.name }}</span>
              <template v-if="r.spec">
                <span v-for="h in r.hosts" :key="h" class="ml-2 rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-800">{{ h }}</span>
                <p class="text-xs text-slate-500">→ {{ r.urls.join(", ") }}<template v-if="r.middlewares.length"> · {{ r.middlewares.join(", ") }}</template></p>
              </template>
              <p v-else class="text-xs text-slate-500">{{ r.summary }}</p>
            </div>
            <div v-if="canEdit && r.spec" class="flex gap-1">
              <button :class="ghost" @click="target = { mode: 'route', item: r, remove: false }">Modifier</button>
              <button :class="[ghost, 'text-red-700']" @click="target = { mode: 'route', item: r, remove: true }">Supprimer</button>
            </div>
          </li>
        </ul>
      </section>

      <p class="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
        Chaque modification crée une révision de l'application
        <RouterLink v-if="state.stack" :to="`/stacks/${state.stack.id}`" class="text-blue-600 underline">{{ state.stack.name }}</RouterLink>
        ; elle s'applique au déploiement, et Traefik recharge ensuite ce fichier sans redémarrer.
        <template v-if="state.sensitive"> Le fichier est marqué sensible (mots de passe hachés).</template>
        Les éléments d'une autre forme sont listés en lecture seule : modifiez le fichier dans l'onglet Fichiers.
      </p>
    </template>

    <TraefikDynamicDialog
      v-if="target && state?.revision !== undefined"
      :mode="target.mode"
      :item="target.item"
      :remove="target.remove"
      :revision="state.revision"
      :middleware-names="middlewareNames"
      @close="target = null"
      @saved="onSaved"
    />
  </PanelCard>
</template>
