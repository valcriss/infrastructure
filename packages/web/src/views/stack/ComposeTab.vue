<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, describeError, type ChangeResult, type StackDetail } from "../../api";
import DiffView from "../../components/DiffView.vue";
import YamlEditor from "../../components/YamlEditor.vue";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

// Révision sur laquelle le brouillon est basé : sert au contrôle de concurrence.
const baseRevision = ref(props.stack.currentRevision);
const saved = ref(props.stack.compose);
const draft = ref(props.stack.compose);
const message = ref("");
const showDiff = ref(false);
const error = ref("");
const info = ref("");
const busy = ref(false);

const sensitive = ref(props.stack.composeSensitive);
const savedSensitive = ref(props.stack.composeSensitive);
const dirty = computed(() => draft.value !== saved.value || sensitive.value !== savedSensitive.value);

// Un rechargement distant ne remplace jamais un brouillon en cours de modification.
watch(
  () => props.stack.currentRevision,
  (rev) => {
    if (!dirty.value) {
      baseRevision.value = rev;
      saved.value = props.stack.compose;
      draft.value = props.stack.compose;
    }
  },
);
const outdated = computed(() => props.stack.currentRevision !== baseRevision.value);

async function save() {
  error.value = "";
  info.value = "";
  busy.value = true;
  try {
    const r = await api<ChangeResult>(`/api/v1/stacks/${props.stack.id}/compose`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: baseRevision.value,
        compose: draft.value,
        sensitive: sensitive.value,
        ...(message.value ? { message: message.value } : {}),
      }),
    });
    baseRevision.value = r.revision;
    saved.value = draft.value;
    savedSensitive.value = sensitive.value;
    message.value = "";
    showDiff.value = false;
    info.value = r.changed
      ? `Révision ${r.revision} enregistrée. Elle n'est pas déployée : utilisez « Déployer » dans la vue d'ensemble.`
      : "Aucune modification : la révision courante est inchangée.";
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function reset() {
  draft.value = saved.value;
  sensitive.value = savedSensitive.value;
  error.value = "";
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="outdated" role="alert" class="rounded bg-amber-50 p-3 text-sm text-amber-800">
      La stack a une révision plus récente ({{ stack.currentRevision }}) que celle de votre brouillon ({{ baseRevision }}). L'enregistrement sera refusé : copiez vos changements, rechargez la page, puis réappliquez-les.
    </p>
    <YamlEditor v-model="draft" label="Fichier Compose" />
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" class="min-w-64 rounded border border-slate-300 px-3 py-2" />
      <button :disabled="!dirty || busy" class="rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
      <button :disabled="!dirty" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" @click="showDiff = !showDiff">
        {{ showDiff ? "Masquer les différences" : "Voir les différences" }}
      </button>
      <button :disabled="!dirty" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" @click="reset">Annuler les modifications</button>
      <span v-if="dirty" class="text-xs text-amber-700">modifications non enregistrées</span>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <DiffView v-if="showDiff" :before="saved" :after="draft" />
    <label class="flex items-center gap-2 text-sm">
      <input v-model="sensitive" type="checkbox" />
      Chiffrer le Compose dans la sauvegarde Git (il contient des secrets)
    </label>
    <p class="text-xs text-slate-500">
      Les valeurs écrites directement dans le Compose restent visibles dans la révision : placez les secrets dans des variables de stack sensibles (<code>${NOM}</code>).
    </p>
  </div>
</template>
