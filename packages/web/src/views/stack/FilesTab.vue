<script setup lang="ts">
import { ref, watch } from "vue";
import { api, describeError, type ChangeResult, type RevisionDetail, type StackDetail } from "../../api";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

const path = ref("");
const content = ref("");
const isNew = ref(false);
const sensitive = ref(false);
const loaded = ref(false);
const error = ref("");
const info = ref("");
const busy = ref(false);

// L'URL conserve les « / » du chemin tout en encodant chaque segment.
const url = (p: string) => `/api/v1/stacks/${props.stack.id}/files/${p.split("/").map(encodeURIComponent).join("/")}`;

async function open(p: string) {
  error.value = info.value = "";
  const rev = await api<RevisionDetail>(`/api/v1/stacks/${props.stack.id}/revisions/${props.stack.currentRevision}`);
  path.value = p;
  content.value = rev.files[p] ?? "";
  sensitive.value = rev.sensitiveFiles.includes(p);
  isNew.value = false;
  loaded.value = true;
}

function create() {
  path.value = "";
  content.value = "";
  sensitive.value = false;
  isNew.value = true;
  loaded.value = true;
  error.value = info.value = "";
}

async function save() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await api<ChangeResult>(url(path.value), {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: props.stack.currentRevision, content: content.value, sensitive: sensitive.value }),
    });
    info.value = r.changed ? `Fichier enregistré (révision ${r.revision}, non déployée).` : "Aucun changement.";
    isNew.value = false;
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (!confirm(`Supprimer le fichier ${path.value} de la configuration ?`)) return;
  error.value = info.value = "";
  busy.value = true;
  try {
    await api(`${url(path.value)}?expectedRevision=${props.stack.currentRevision}`, { method: "DELETE" });
    loaded.value = false;
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

watch(() => props.stack.id, () => (loaded.value = false));
</script>

<template>
  <div class="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
    <aside class="self-start rounded-lg border border-slate-200 bg-white">
      <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 class="text-sm font-semibold">Fichiers associés</h2>
        <button class="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700" @click="create"><FaIcon :icon="['fas', 'plus']" /> Nouveau</button>
      </div>
      <p v-if="stack.files.length === 0" class="px-4 py-4 text-sm text-slate-500">Aucun fichier.</p>
      <ul v-else class="divide-y divide-slate-100 text-sm">
        <li v-for="f in stack.files" :key="f">
          <button class="w-full px-4 py-2 text-left font-mono text-xs hover:bg-slate-100" :class="{ 'bg-slate-100 font-semibold': f === path && !isNew }" @click="open(f)">
            {{ f }}<span v-if="stack.sensitiveFiles.includes(f)" class="ml-1 text-amber-700" title="Chiffré dans la sauvegarde Git">🔒</span>
          </button>
        </li>
      </ul>
    </aside>

    <section v-if="loaded" class="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <label class="block text-sm">
        <span class="font-medium">Chemin relatif</span>
        <input v-model="path" :readonly="!isNew" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs read-only:bg-slate-100" placeholder="nginx/default.conf" />
      </label>
      <label class="block text-sm">
        <span class="font-medium">Contenu</span>
        <textarea v-model="content" spellcheck="false" class="mt-1 h-[calc(100dvh-26rem)] min-h-64 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"></textarea>
      </label>
      <label class="flex items-center gap-2 text-sm"><input v-model="sensitive" type="checkbox" /> Fichier sensible (chiffré dans la sauvegarde Git)</label>
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
      <div class="flex gap-2 text-sm">
        <button :disabled="busy || !path" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer</button>
        <button v-if="!isNew" :disabled="busy" class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50" @click="remove">Supprimer</button>
      </div>
    </section>

    <section v-else class="flex min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
      <FaIcon :icon="['fas', 'folder-open']" class="text-2xl text-slate-400" />
      <p class="font-medium text-slate-600">Fichiers de configuration de l'application</p>
      <p class="max-w-md">
        Ces fichiers sont versionnés avec la révision et écrits à côté du Compose lors du déploiement : un chemin relatif comme <code>./nginx/default.conf</code> y est résolu.
        {{ stack.files.length === 0 ? "Aucun fichier pour l'instant : cliquez sur « Nouveau » pour en ajouter un." : "Sélectionnez un fichier dans la liste ou créez-en un." }}
      </p>
    </section>
  </div>
</template>
