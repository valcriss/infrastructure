<script setup lang="ts">
import { reactive, ref } from "vue";
import { api, describeError, type BackupStatus, type ConnectionTest } from "../api";

const props = defineProps<{ status?: BackupStatus | null }>();
const emit = defineEmits<{ saved: [status: BackupStatus]; tested: [result: ConnectionTest] }>();

const form = reactive({
  url: props.status?.repoUrl ?? "",
  username: props.status?.username ?? "",
  token: "",
  branch: props.status?.branch ?? "main",
});
const result = ref<ConnectionTest | null>(null);
const error = ref("");
const busy = ref(false);

const body = () => ({
  url: form.url,
  username: form.username,
  branch: form.branch,
  ...(form.token ? { token: form.token } : {}),
});

async function test() {
  error.value = "";
  result.value = null;
  busy.value = true;
  try {
    result.value = await api<ConnectionTest>("/api/v1/backup/test", { method: "POST", body: JSON.stringify(body()) });
    emit("tested", result.value);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/** Enregistre le dépôt ; retourne vrai en cas de succès. */
async function save(): Promise<boolean> {
  error.value = "";
  busy.value = true;
  try {
    const status = await api<BackupStatus>("/api/v1/backup/config", { method: "PUT", body: JSON.stringify(body()) });
    form.token = "";
    emit("saved", status);
    return true;
  } catch (err) {
    error.value = describeError(err);
    return false;
  } finally {
    busy.value = false;
  }
}

defineExpose({ save, form, result });
</script>

<template>
  <form class="space-y-4" @submit.prevent="save">
    <label class="block text-sm">
      <span class="font-medium">URL du dépôt (HTTPS)</span>
      <input v-model="form.url" required type="url" placeholder="https://git.exemple.org/equipe/sauvegarde-console.git" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
    </label>
    <div class="grid gap-4 sm:grid-cols-2">
      <label class="block text-sm">
        <span class="font-medium">Identifiant</span>
        <input v-model="form.username" required autocomplete="off" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
      </label>
      <label class="block text-sm">
        <span class="font-medium">Jeton d'accès (droits d'écriture)</span>
        <input v-model="form.token" type="password" :required="!status?.configured" autocomplete="off" :placeholder="status?.configured ? 'inchangé' : ''" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
      </label>
    </div>
    <label class="block text-sm sm:w-1/2">
      <span class="font-medium">Branche</span>
      <input v-model="form.branch" required class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
    </label>
    <p class="text-xs text-slate-500">
      Un dépôt dédié, de préférence privé. Le jeton est chiffré avec la clé maître de la console : il n'est ni écrit dans Git, ni renvoyé par l'API, ni sauvegardé.
    </p>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <div v-if="result" class="rounded border p-3 text-sm" :class="result.remote === 'foreign_content' ? 'border-red-300 bg-red-50 text-red-800' : result.remote === 'has_backup' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-green-300 bg-green-50 text-green-800'">
      <template v-if="result.remote === 'empty' || result.remote === 'branch_missing'">Connexion réussie. Le dépôt est vide : la première sauvegarde y sera créée.</template>
      <template v-else-if="result.remote === 'has_backup'">
        Connexion réussie. Ce dépôt contient déjà une sauvegarde (révision de configuration {{ result.backup?.configRevision }}{{ result.backup?.sameInstallation ? ", de cette installation" : ", d'une autre installation" }}).
      </template>
      <template v-else>Connexion réussie, mais le dépôt contient d'autres données qu'une sauvegarde de la console : utilisez un dépôt vide ou une branche dédiée.</template>
    </div>

    <div class="flex flex-wrap gap-3">
      <button type="button" :disabled="busy" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50" @click="test">Tester la connexion</button>
      <slot name="actions" :busy="busy" :result="result" :save="save" />
    </div>
  </form>
</template>
