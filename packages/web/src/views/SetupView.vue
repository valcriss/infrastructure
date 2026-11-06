<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, describeError, type ConnectionTest, type RestorePreview } from "../api";
import GitRepoForm from "../components/GitRepoForm.vue";
import KeyReveal from "../components/KeyReveal.vue";
import { useSession } from "../stores/session";

type Step = "account" | "git" | "key";

const session = useSession();
const router = useRouter();
const step = ref<Step>("account");

// --- Étape 1 : compte administrateur -------------------------------------------
const setupToken = ref("");
const username = ref("admin");
const password = ref("");
const confirm = ref("");
const error = ref("");
const busy = ref(false);

async function createAccount() {
  error.value = "";
  if (password.value.length < 12) {
    error.value = "Le mot de passe doit contenir au moins 12 caractères.";
    return;
  }
  if (password.value !== confirm.value) {
    error.value = "Les mots de passe ne correspondent pas.";
    return;
  }
  busy.value = true;
  try {
    await session.setup(setupToken.value.trim(), username.value, password.value);
    step.value = "git";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Erreur inattendue.";
  } finally {
    busy.value = false;
  }
}

// --- Étape 2 : dépôt Git de sauvegarde (optionnel) -------------------------------
const form = ref<InstanceType<typeof GitRepoForm> | null>(null);
const tested = ref<ConnectionTest | null>(null);
const restoreKey = ref("");
const preview = ref<RestorePreview | null>(null);
const mapping = ref<Record<string, string>>({});
const gitError = ref("");
const gitBusy = ref(false);

const canRestore = computed(() => tested.value?.remote === "has_backup");

async function saveAndContinue() {
  gitError.value = "";
  gitBusy.value = true;
  try {
    if (await form.value?.save()) step.value = "key";
  } finally {
    gitBusy.value = false;
  }
}

async function analyse() {
  gitError.value = "";
  gitBusy.value = true;
  try {
    // L'analyse utilise le dépôt enregistré : on l'enregistre d'abord.
    if (!(await form.value?.save())) return;
    preview.value = await api<RestorePreview>("/api/v1/backup/restore/preview", {
      method: "POST",
      body: JSON.stringify(restoreKey.value ? { restorationKey: restoreKey.value } : {}),
    });
    mapping.value = Object.fromEntries(
      preview.value.backupHosts.map((h) => [h.id, preview.value?.availableHosts.length === 1 ? (preview.value.availableHosts[0]?.id ?? "") : ""]),
    );
  } catch (err) {
    gitError.value = describeError(err);
  } finally {
    gitBusy.value = false;
  }
}

async function restore() {
  if (!preview.value) return;
  gitError.value = "";
  gitBusy.value = true;
  try {
    await api("/api/v1/backup/restore", {
      method: "POST",
      body: JSON.stringify({
        previewId: preview.value.previewId,
        hostMapping: Object.fromEntries(Object.entries(mapping.value).filter(([, v]) => v)),
      }),
    });
    const recipient = await api<{ recipient: string | null }>("/api/v1/admin/restoration-key");
    // La clé de restauration du dépôt est reprise : inutile d'en générer une nouvelle.
    if (recipient.recipient) await finish();
    else step.value = "key";
  } catch (err) {
    gitError.value = describeError(err);
  } finally {
    gitBusy.value = false;
  }
}

async function finish() {
  session.hasRestorationKey = true;
  await router.push("/dashboard");
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <ol class="flex gap-2 text-xs text-slate-500" aria-label="Étapes de l'initialisation">
      <li :class="{ 'font-semibold text-slate-900': step === 'account' }">1. Compte</li>
      <li aria-hidden="true">›</li>
      <li :class="{ 'font-semibold text-slate-900': step === 'git' }">2. Dépôt Git de sauvegarde</li>
      <li aria-hidden="true">›</li>
      <li :class="{ 'font-semibold text-slate-900': step === 'key' }">3. Clé de restauration</li>
    </ol>

    <!-- Étape 1 -->
    <section v-if="step === 'account'" class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h1 class="text-xl font-semibold">Première configuration</h1>
      <p class="mt-2 text-sm text-slate-600">
        Créez le compte administrateur. Le secret d'initialisation est affiché dans les logs de la console :
        <code class="rounded bg-slate-100 px-1">docker compose logs console</code>.
      </p>
      <form class="mt-6 space-y-4" @submit.prevent="createAccount">
        <label class="block text-sm">
          <span class="font-medium">Secret d'initialisation</span>
          <input v-model="setupToken" required autocomplete="off" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Identifiant</span>
          <input v-model="username" required minlength="3" autocomplete="username" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Mot de passe (12 caractères minimum)</span>
          <input v-model="password" type="password" required autocomplete="new-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Confirmation</span>
          <input v-model="confirm" type="password" required autocomplete="new-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <button :disabled="busy" class="w-full rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50">Créer le compte</button>
      </form>
    </section>

    <!-- Étape 2 -->
    <section v-else-if="step === 'git'" class="space-y-6">
      <div class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 class="text-xl font-semibold">Dépôt Git de sauvegarde</h1>
        <p class="mt-2 text-sm text-slate-600">
          La configuration de la console (stacks, variables, fichiers) est sauvegardée dans un dépôt Git unique, les secrets étant chiffrés.
          Sur une nouvelle installation, indiquez le dépôt d'une sauvegarde existante pour restaurer votre configuration. Cette étape peut être faite plus tard.
        </p>
        <div class="mt-6">
          <GitRepoForm ref="form" @tested="tested = $event">
            <template #actions="{ busy: formBusy, result }">
              <button
                v-if="result && result.remote !== 'has_backup' && result.remote !== 'foreign_content'"
                type="button"
                :disabled="formBusy || gitBusy"
                class="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
                @click="saveAndContinue"
              >
                Enregistrer et continuer
              </button>
              <button type="button" class="ml-auto rounded px-3 py-2 text-sm text-slate-600 underline" @click="step = 'key'">Passer cette étape</button>
            </template>
          </GitRepoForm>
          <p v-if="gitError" role="alert" class="mt-3 text-sm text-red-700">{{ gitError }}</p>
        </div>
      </div>

      <div v-if="canRestore" class="rounded-lg border border-amber-300 bg-amber-50 p-6">
        <h2 class="text-lg font-semibold">Restaurer la configuration depuis ce dépôt</h2>
        <p class="mt-2 text-sm text-slate-700">
          Les stacks, variables, fichiers et paramètres sont importés <strong>sans démarrer ni arrêter aucun conteneur</strong>. Les agents ne sont pas restaurés :
          vous associerez chaque hôte de la sauvegarde à un hôte enrôlé sur cette console. Le compte administrateur reste celui que vous venez de créer.
        </p>
        <label class="mt-4 block text-sm">
          <span class="font-medium">Clé de restauration privée (AGE-SECRET-KEY-…)</span>
          <input v-model="restoreKey" type="password" autocomplete="off" class="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 font-mono text-xs" />
          <span class="text-xs text-slate-500">Nécessaire si le dépôt contient des secrets chiffrés. Elle n'est jamais enregistrée.</span>
        </label>
        <button :disabled="gitBusy" class="mt-3 rounded border border-slate-400 bg-white px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50" @click="analyse">Analyser la sauvegarde</button>

        <div v-if="preview" class="mt-6 space-y-4 text-sm">
          <h3 class="font-medium">{{ preview.stacks.length }} stack(s) à restaurer</h3>
          <ul class="divide-y divide-amber-200 rounded border border-amber-200 bg-white">
            <li v-for="s in preview.stacks" :key="s.id" class="px-3 py-2">
              <span class="font-medium">{{ s.name }}</span>
              <span class="ml-2 text-xs text-slate-500">{{ s.variables }} variable(s) · {{ s.files }} fichier(s)</span>
              <span v-if="s.conflict !== 'none'" class="ml-2 rounded bg-red-100 px-1.5 text-xs text-red-800">conflit</span>
            </li>
          </ul>
          <div v-if="preview.backupHosts.length">
            <h3 class="font-medium">Association des hôtes</h3>
            <p v-if="preview.availableHosts.length === 0" class="text-amber-800">
              Aucun hôte n'est encore enrôlé : l'agent local se connecte dans la minute qui suit l'initialisation. Patientez puis relancez l'analyse.
            </p>
            <div v-for="h in preview.backupHosts" :key="h.id" class="mt-2 flex items-center gap-2">
              <span class="w-40 truncate">{{ h.name }}</span>
              <span aria-hidden="true">→</span>
              <select v-model="mapping[h.id]" :aria-label="`Hôte pour ${h.name}`" class="rounded border border-slate-300 bg-white px-2 py-1">
                <option value="">— choisir —</option>
                <option v-for="a in preview.availableHosts" :key="a.id" :value="a.id">{{ a.name }}</option>
              </select>
            </div>
          </div>
          <p v-if="preview.hasSecrets" class="text-xs text-slate-600">Les secrets ont été déchiffrés avec votre clé ; elle sera reprise comme clé de restauration de cette console.</p>
          <button :disabled="gitBusy || Object.values(mapping).some((v) => !v)" class="rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="restore">
            Restaurer la configuration
          </button>
        </div>
      </div>
    </section>

    <!-- Étape 3 -->
    <KeyReveal v-else @done="finish" />
  </div>
</template>
