<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, describeError, fmtDate, type BackupState, type BackupStatus } from "../../api";
import GitRepoForm from "../../components/GitRepoForm.vue";
import KeyReveal from "../../components/KeyReveal.vue";
import { useSession } from "../../stores/session";

const session = useSession();
const status = ref<BackupStatus | null>(null);
const error = ref("");
const info = ref("");
const showForm = ref(false);
let timer: number | undefined;

async function load() {
  try {
    status.value = await api<BackupStatus>("/api/v1/backup/status");
    session.hasRestorationKey = status.value.hasRestorationKey;
  } catch (err) {
    error.value = describeError(err);
  }
}

async function syncNow() {
  error.value = info.value = "";
  try {
    status.value = await api<BackupStatus>("/api/v1/backup/sync", { method: "POST" });
    info.value = "Synchronisation demandée.";
  } catch (err) {
    error.value = describeError(err);
  }
}

async function disable() {
  if (!confirm("Désactiver la sauvegarde Git ? Le jeton enregistré est supprimé ; le dépôt distant n'est pas modifié.")) return;
  try {
    await api("/api/v1/backup/config", { method: "DELETE" });
    showForm.value = false;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

function saved(s: BackupStatus) {
  status.value = s;
  showForm.value = false;
  info.value = "Dépôt enregistré. La première synchronisation démarre dans quelques secondes.";
}

const badge: Record<BackupState, { text: string; cls: string }> = {
  not_configured: { text: "non configurée", cls: "bg-slate-200 text-slate-800" },
  disabled: { text: "désactivée", cls: "bg-slate-200 text-slate-800" },
  ok: { text: "à jour", cls: "bg-green-100 text-green-800" },
  pending: { text: "en attente de push", cls: "bg-blue-100 text-blue-800" },
  error: { text: "en échec (nouvelle tentative automatique)", cls: "bg-amber-100 text-amber-800" },
  blocked: { text: "bloquée", cls: "bg-red-100 text-red-800" },
};
const hints: Record<string, string> = {
  diverged: "Le dépôt distant contient des commits que cette console n'a pas : rien n'est écrasé. Intégrez ces changements ou utilisez un autre dépôt/une autre branche, puis relancez.",
  remote_not_empty: "Le dépôt contient déjà des données : restaurez-les depuis l'assistant d'initialisation ou choisissez un dépôt vide.",
  foreign_installation: "Ce dépôt appartient à une autre installation de la console.",
  no_recipient: "Générez la clé de restauration ci-dessous : elle est nécessaire pour chiffrer les secrets.",
  token_unreadable: "Saisissez à nouveau le jeton Git.",
};
const hint = computed(() => (status.value?.lastError ? hints[status.value.lastError.code] : undefined));

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>

    <section v-if="status" class="rounded-lg border border-slate-200 bg-white p-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold">État</h2>
          <span class="rounded px-2 py-0.5 text-xs" :class="badge[status.state].cls">{{ badge[status.state].text }}</span>
        </div>
        <button v-if="status.configured" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100" @click="syncNow">Synchroniser maintenant</button>
      </div>

      <dl v-if="status.configured" class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt class="text-slate-500">Dépôt</dt><dd class="break-all">{{ status.repoUrl }} ({{ status.branch }})</dd></div>
        <div><dt class="text-slate-500">Dernier push réussi</dt><dd>{{ fmtDate(status.lastPushAt) }}</dd></div>
        <div><dt class="text-slate-500">Révisions de configuration</dt><dd>{{ status.configRevision }} · poussées {{ status.pushedRevision }} · en attente {{ status.pendingRevisions }}</dd></div>
        <div><dt class="text-slate-500">Dernier commit poussé</dt><dd class="font-mono text-xs">{{ status.pushedCommit?.slice(0, 12) ?? "—" }}</dd></div>
      </dl>
      <p v-else class="mt-3 text-sm text-slate-600">Aucun dépôt configuré : la configuration n'est pas sauvegardée hors de cette console.</p>

      <div v-if="status.lastError" role="alert" class="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <p class="font-medium">{{ status.lastError.message }}</p>
        <p v-if="hint" class="mt-1">{{ hint }}</p>
        <p class="mt-1 text-xs text-red-700">Code {{ status.lastError.code }} · {{ fmtDate(status.lastError.at) }}<span v-if="status.nextRetryAt"> · prochaine tentative {{ fmtDate(status.nextRetryAt) }}</span></p>
      </div>
      <p v-else-if="status.state === 'pending'" class="mt-4 text-sm text-slate-600">
        Des changements sont en attente. Un enregistrement n'est jamais présumé sauvegardé tant que le push distant n'a pas réussi.
      </p>
    </section>

    <section v-if="status && !status.hasRestorationKey">
      <KeyReveal @done="load" />
    </section>

    <section v-if="status" class="rounded-lg border border-slate-200 bg-white p-6">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Dépôt de sauvegarde</h2>
        <button v-if="!showForm" class="text-sm underline" @click="showForm = true">{{ status.configured ? "Modifier" : "Configurer" }}</button>
      </div>
      <div v-if="showForm" class="mt-4">
        <GitRepoForm :status="status" @saved="saved">
          <template #actions="{ busy, save }">
            <button type="button" :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer</button>
            <button type="button" class="rounded px-3 py-2 text-sm text-slate-600 underline" @click="showForm = false">Annuler</button>
            <button v-if="status.configured" type="button" class="ml-auto rounded border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50" @click="disable">Désactiver</button>
          </template>
        </GitRepoForm>
      </div>
      <p class="mt-4 text-xs text-slate-500">
        Contenu sauvegardé : paramètres, stacks (Compose, variables, fichiers associés). Non sauvegardés : volumes, base de données de la console, journaux, sessions, jetons API et identifiants Git.
        Les variables et fichiers marqués « sensibles » (et les Compose chiffrés) sont chiffrés avec votre clé de restauration. Un chiffrement par motifs ne détecte pas tous les secrets : classez explicitement ce qui est sensible.
      </p>
    </section>

    <section v-if="status?.hasRestorationKey" class="rounded-lg border border-slate-200 bg-white p-6 text-sm">
      <h2 class="text-lg font-semibold">Clé de restauration</h2>
      <p class="mt-2 text-slate-600">
        La console ne conserve que la clé publique. Sans la clé privée, les secrets sauvegardés dans Git sont irrécupérables. Rappel : un secret retiré du dépôt reste présent dans l'historique Git.
      </p>
    </section>
  </div>
</template>
