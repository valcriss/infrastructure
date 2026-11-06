<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError } from "../api";
import { useSession } from "../stores/session";

const session = useSession();
const router = useRouter();
const setupToken = ref("");
const username = ref("admin");
const password = ref("");
const confirm = ref("");
const error = ref("");
const busy = ref(false);
const restorationKey = ref("");
const recipient = ref("");
const saved = ref(false);

function downloadKey() {
  const blob = new Blob([`# Clé de restauration — à conserver hors de la console et hors du dépôt Git\n# Clé publique : ${recipient.value}\n${restorationKey.value}\n`], {
    type: "text/plain",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "cle-de-restauration.txt";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function done() {
  restorationKey.value = "";
  await router.push("/hosts");
}

async function submit() {
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
    const r = await session.setup(setupToken.value.trim(), username.value, password.value);
    restorationKey.value = r.restorationKey;
    recipient.value = r.restorationRecipient;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Erreur inattendue.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="restorationKey" class="mx-auto max-w-lg rounded-lg border border-amber-300 bg-amber-50 p-6 shadow-sm">
    <h1 class="text-xl font-semibold">Clé de restauration</h1>
    <p class="mt-2 text-sm text-slate-700">
      Cette clé chiffre les secrets sauvegardés dans Git. <strong>Elle n'est affichée qu'une seule fois</strong> et
      n'est pas conservée par la console. Sans elle, les secrets sauvegardés sont irrécupérables. Conservez-la dans un
      gestionnaire de mots de passe, séparément du dépôt Git.
    </p>
    <code class="mt-4 block break-all rounded bg-white px-3 py-2 font-mono text-xs">{{ restorationKey }}</code>
    <div class="mt-3 flex gap-2 text-sm">
      <button type="button" class="rounded border border-slate-300 bg-white px-3 py-1 hover:bg-slate-100" @click="downloadKey">
        Télécharger
      </button>
    </div>
    <label class="mt-4 flex items-center gap-2 text-sm">
      <input v-model="saved" type="checkbox" />
      J'ai sauvegardé cette clé en lieu sûr.
    </label>
    <button :disabled="!saved" class="mt-4 w-full rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="done">
      Continuer
    </button>
  </section>
  <section v-else class="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
    <h1 class="text-xl font-semibold">Première configuration</h1>
    <p class="mt-2 text-sm text-slate-600">
      Créez le compte administrateur. Le secret d'initialisation est affiché dans les logs de la console :
      <code class="rounded bg-slate-100 px-1">docker compose logs console</code>.
    </p>
    <form class="mt-6 space-y-4" @submit.prevent="submit">
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
      <button :disabled="busy" class="w-full rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50">
        Créer le compte
      </button>
    </form>
  </section>
</template>
