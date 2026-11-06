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
  <div class="grid gap-6 md:grid-cols-[16rem_1fr]">
    <aside class="rounded-lg border border-slate-200 bg-white">
      <div class="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 class="text-sm font-semibold">Fichiers associés</h2>
        <button class="text-sm underline" @click="create">Nouveau</button>
      </div>
      <p v-if="stack.files.length === 0" class="px-3 py-3 text-sm text-slate-500">Aucun fichier.</p>
      <ul v-else class="text-sm">
        <li v-for="f in stack.files" :key="f">
          <button class="w-full px-3 py-2 text-left font-mono text-xs hover:bg-slate-100" :class="{ 'bg-slate-100 font-semibold': f === path && !isNew }" @click="open(f)">
            {{ f }}<span v-if="stack.sensitiveFiles.includes(f)" class="ml-1 text-amber-700" title="Chiffré dans la sauvegarde Git">🔒</span>
          </button>
        </li>
      </ul>
      <p class="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
        Ces fichiers sont écrits à côté du Compose : un chemin relatif comme <code>./nginx/default.conf</code> y est résolu.
      </p>
    </aside>

    <section v-if="loaded" class="space-y-3">
      <label class="block text-sm">
        <span class="font-medium">Chemin relatif</span>
        <input v-model="path" :readonly="!isNew" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs read-only:bg-slate-100" placeholder="nginx/default.conf" />
      </label>
      <label class="block text-sm">
        <span class="font-medium">Contenu</span>
        <textarea v-model="content" rows="16" spellcheck="false" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"></textarea>
      </label>
      <label class="flex items-center gap-2 text-sm"><input v-model="sensitive" type="checkbox" /> Fichier sensible (chiffré dans la sauvegarde Git)</label>
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
      <div class="flex gap-2 text-sm">
        <button :disabled="busy || !path" class="rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="save">Enregistrer</button>
        <button v-if="!isNew" :disabled="busy" class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50" @click="remove">Supprimer</button>
      </div>
    </section>
    <p v-else class="text-sm text-slate-500">Sélectionnez un fichier ou créez-en un.</p>
  </div>
</template>
