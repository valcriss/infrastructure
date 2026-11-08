<script setup lang="ts">
import { ref } from "vue";
import { api, describeError, type ChangeResult, type StackDetail, type VariableView } from "../../api";
import ExtractVariablesDialog from "../../components/ExtractVariablesDialog.vue";
import { useSession } from "../../stores/session";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

const session = useSession();
const extracting = ref(false);
const name = ref("");
const value = ref("");
const sensitive = ref(false);
const editing = ref(false);
const error = ref("");
const info = ref("");
const busy = ref(false);

function edit(v: VariableView) {
  name.value = v.name;
  // Une valeur sensible n'est jamais renvoyée par l'API : on la remplace ou on la conserve.
  value.value = v.sensitive ? "" : (v.value ?? "");
  sensitive.value = v.sensitive;
  editing.value = true;
}

function clear() {
  name.value = value.value = "";
  sensitive.value = false;
  editing.value = false;
}

async function patch(body: { set?: Record<string, unknown>; unset?: string[] }, okMessage: string) {
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await api<ChangeResult>(`/api/v1/stacks/${props.stack.id}/variables`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: props.stack.currentRevision, ...body }),
    });
    info.value = r.changed ? `${okMessage} Révision ${r.revision} enregistrée, non déployée.` : "Aucun changement.";
    clear();
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const save = () =>
  patch(
    { set: { [name.value]: { ...(value.value !== "" || !editing.value ? { value: value.value } : {}), sensitive: sensitive.value } } },
    "Variable enregistrée.",
  );

async function remove(v: VariableView) {
  if (confirm(`Supprimer la variable ${v.name} ?`)) await patch({ unset: [v.name] }, "Variable supprimée.");
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-3xl text-sm text-slate-600">
        Variables d'interpolation de la stack (<code>${NOM}</code> dans le Compose). Une valeur sensible n'est plus jamais affichée après son enregistrement.
      </p>
      <button v-if="session.canOperate" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100" title="Transformer les valeurs de « environment » en variables de stack" @click="extracting = true">Extraire les variables du Compose…</button>
    </div>
    <ExtractVariablesDialog v-if="extracting" :stack-id="stack.id" @close="extracting = false" @saved="extracting = false; info = `Révision enregistrée : valeurs extraites en variables. Elle n'est pas déployée.`; emit('changed')" />

    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full text-left text-sm">
        <thead class="text-xs text-slate-500">
          <tr><th class="px-4 py-1">Nom</th><th class="px-4 py-1">Valeur</th><th class="px-4 py-1"><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr v-if="stack.variables.length === 0"><td colspan="3" class="px-4 py-3 text-slate-500">Aucune variable.</td></tr>
          <tr v-for="v in stack.variables" :key="v.name" class="border-t border-slate-100">
            <td class="px-4 py-2 font-mono text-xs">{{ v.name }}</td>
            <td class="px-4 py-2 font-mono text-xs">
              <span v-if="v.sensitive" class="text-slate-500">•••••• (sensible)</span>
              <span v-else>{{ v.value }}</span>
            </td>
            <td class="px-4 py-2 text-right text-sm">
              <button class="mr-2 underline" @click="edit(v)">Modifier</button>
              <button class="text-red-700 underline" @click="remove(v)">Supprimer</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="max-w-2xl space-y-3 rounded-lg border border-slate-200 bg-white p-4" @submit.prevent="save">
      <h2 class="font-semibold">{{ editing ? `Modifier ${name}` : "Ajouter une variable" }}</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block text-sm">
          <span class="font-medium">Nom</span>
          <input v-model="name" :readonly="editing" required pattern="[A-Za-z_][A-Za-z0-9_]*" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs read-only:bg-slate-100" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Valeur</span>
          <input
            v-model="value"
            :type="sensitive ? 'password' : 'text'"
            :required="!editing"
            :placeholder="editing && sensitive ? 'laisser vide pour conserver' : ''"
            autocomplete="off"
            class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
          />
        </label>
      </div>
      <label class="flex items-center gap-2 text-sm"><input v-model="sensitive" type="checkbox" /> Valeur sensible (masquée dans l'API et les journaux)</label>
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
      <div class="flex gap-2">
        <button :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">Enregistrer</button>
        <button v-if="editing" type="button" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100" @click="clear">Annuler</button>
      </div>
    </form>
  </div>
</template>
