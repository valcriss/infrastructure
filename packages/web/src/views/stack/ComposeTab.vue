<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, describeError, type ChangeResult, type StackDetail } from "../../api";
import DiffView from "../../components/DiffView.vue";
import ExtractVariablesDialog from "../../components/ExtractVariablesDialog.vue";
import YamlEditor from "../../components/YamlEditor.vue";
import { useSession } from "../../stores/session";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();
const session = useSession();

// Révision sur laquelle le brouillon est basé : sert au contrôle de concurrence.
const baseRevision = ref(props.stack.currentRevision);
const saved = ref(props.stack.compose);
const draft = ref(props.stack.compose);
const message = ref("");
const extracting = ref(false);
const showDiff = ref(false);
const error = ref("");
const info = ref("");
const busy = ref(false);
const editor = ref<InstanceType<typeof YamlEditor> | null>(null);

/** Erreurs de validation du Compose renvoyées par le serveur, avec leur position quand elle est connue. */
interface Issue {
  message: string;
  line?: number;
  column?: number;
}
const issues = ref<Issue[]>([]);
/** Dernier enregistrement : sert à proposer les différences et la suite (déploiement). */
const lastSave = ref<{ revision: number; changed: boolean; before: string; after: string } | null>(null);
const showLastDiff = ref(false);
const conflict = ref(false);
const showConflictDiff = ref(false);

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
// Une révision plus récente existe pendant qu'on édite : l'enregistrement serait refusé tant qu'on ne choisit pas.
const outdated = computed(() => props.stack.currentRevision !== baseRevision.value);
const inConflict = computed(() => outdated.value || conflict.value);

function onExtracted(revision: number, count: number) {
  extracting.value = false;
  info.value = `Révision ${revision} enregistrée : ${count} valeur(s) extraite(s) en variables. Elle n'est pas déployée : utilisez « Déployer » dans la vue d'ensemble.`;
  emit("changed");
}

async function save() {
  error.value = "";
  info.value = "";
  issues.value = [];
  lastSave.value = null;
  busy.value = true;
  const before = saved.value;
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
    conflict.value = false;
    showConflictDiff.value = false;
    lastSave.value = { revision: r.revision, changed: r.changed, before, after: draft.value };
    showLastDiff.value = false;
    emit("changed");
  } catch (err) {
    // La saisie est toujours conservée : l'erreur n'efface jamais le brouillon.
    if (err instanceof ApiError && err.code === "invalid_compose" && Array.isArray(err.details)) {
      issues.value = err.details as Issue[];
      error.value = `Compose invalide (${issues.value.length} problème${issues.value.length > 1 ? "s" : ""}). Votre saisie est conservée.`;
    } else if (err instanceof ApiError && err.code === "revision_conflict") {
      conflict.value = true;
      emit("changed"); // récupère la dernière révision pour la comparaison
    } else {
      error.value = describeError(err);
    }
  } finally {
    busy.value = false;
  }
}

function reset() {
  draft.value = saved.value;
  sensitive.value = savedSensitive.value;
  error.value = "";
  issues.value = [];
}

/** Conflit : repart de la dernière révision tout en gardant ses modifications (l'enregistrement les appliquera par-dessus). */
function keepMineOnLatest() {
  baseRevision.value = props.stack.currentRevision;
  saved.value = props.stack.compose;
  conflict.value = false;
  showConflictDiff.value = false;
  error.value = "";
}

/** Conflit : abandonne ses modifications et recharge la dernière révision. */
function takeLatest() {
  baseRevision.value = props.stack.currentRevision;
  saved.value = props.stack.compose;
  draft.value = props.stack.compose;
  conflict.value = false;
  showConflictDiff.value = false;
  issues.value = [];
}

function goToLine(i: Issue) {
  if (i.line) editor.value?.goToLine(i.line, i.column ?? 1);
}

/** Retour à la vue d'ensemble, où se trouve le bouton de déploiement. */
function prepareDeploy() {
  void router.replace({ query: {} });
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="inConflict" role="alert" class="space-y-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p>
        Une révision plus récente ({{ stack.currentRevision }}) a été enregistrée pendant votre modification (votre brouillon part de la révision {{ baseRevision }}).
        <strong>Votre saisie est conservée</strong> ; l'enregistrement reste refusé tant que vous ne choisissez pas comment reprendre.
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="rounded border border-amber-400 bg-white px-3 py-1.5 text-slate-900 hover:bg-amber-100" @click="showConflictDiff = !showConflictDiff">
          {{ showConflictDiff ? "Masquer la comparaison" : "Comparer avec la dernière révision" }}
        </button>
        <button class="rounded border border-amber-400 bg-white px-3 py-1.5 text-slate-900 hover:bg-amber-100" @click="keepMineOnLatest">Garder mes modifications sur la dernière révision</button>
        <button class="rounded border border-amber-400 bg-white px-3 py-1.5 text-slate-900 hover:bg-amber-100" @click="takeLatest">Abandonner mes modifications et recharger</button>
      </div>
      <div v-if="showConflictDiff" class="text-slate-900">
        <p class="mb-1 text-xs">À gauche (rouge) : la dernière révision enregistrée ; à droite (vert) : votre saisie.</p>
        <DiffView :before="stack.compose" :after="draft" />
      </div>
    </div>

    <YamlEditor ref="editor" v-model="draft" label="Fichier Compose" />

    <div v-if="issues.length" role="alert" class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      <p class="font-medium">{{ error }}</p>
      <ul class="mt-2 space-y-1">
        <li v-for="(i, n) in issues" :key="n" class="flex flex-wrap items-center gap-2">
          <button v-if="i.line" class="rounded border border-red-300 bg-white px-2 py-0.5 text-xs text-red-800 hover:bg-red-100" @click="goToLine(i)">ligne {{ i.line }}<template v-if="i.column">, col. {{ i.column }}</template></button>
          <span>{{ i.message }}</span>
        </li>
      </ul>
    </div>

    <div class="flex flex-wrap items-center gap-3 text-sm">
      <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" class="min-w-64 rounded border border-slate-300 px-3 py-2" />
      <button :disabled="!dirty || busy" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
      <button :disabled="!dirty" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" @click="showDiff = !showDiff">
        {{ showDiff ? "Masquer les différences" : "Voir les différences" }}
      </button>
      <button :disabled="!dirty" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" @click="reset">Annuler les modifications</button>
      <button v-if="session.canOperate" :disabled="dirty" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" :title="dirty ? 'Enregistrez ou annulez vos modifications avant' : 'Transformer les valeurs de environment en variables de stack'" @click="extracting = true">Extraire les variables…</button>
      <span v-if="dirty" class="text-xs text-amber-700">modifications non enregistrées</span>
    </div>
    <p v-if="error && !issues.length" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <DiffView v-if="showDiff" :before="saved" :after="draft" />

    <div v-if="lastSave" role="status" class="space-y-2 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900">
      <p v-if="lastSave.changed"><strong>Révision {{ lastSave.revision }} enregistrée.</strong> Elle n'est pas déployée : les conteneurs ne changent qu'au déploiement.</p>
      <p v-else>Aucune modification : la révision courante ({{ lastSave.revision }}) est inchangée, il n'y a rien de plus à déployer.</p>
      <div v-if="lastSave.changed" class="flex flex-wrap gap-2">
        <button class="rounded border border-green-400 bg-white px-3 py-1.5 text-slate-900 hover:bg-green-100" @click="showLastDiff = !showLastDiff">{{ showLastDiff ? "Masquer les différences" : "Voir les différences" }}</button>
        <button class="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700" @click="prepareDeploy">Préparer le déploiement</button>
      </div>
      <DiffView v-if="showLastDiff" :before="lastSave.before" :after="lastSave.after" />
    </div>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <ExtractVariablesDialog v-if="extracting" :stack-id="stack.id" @close="extracting = false" @saved="onExtracted" />

    <label class="flex items-center gap-2 text-sm">
      <input v-model="sensitive" type="checkbox" />
      Chiffrer le Compose dans la sauvegarde Git (il contient des secrets)
    </label>
    <p class="text-xs text-slate-500">
      Les valeurs écrites directement dans le Compose restent visibles dans la révision : placez les secrets dans des variables de stack sensibles (<code>${NOM}</code>).
    </p>
  </div>
</template>
