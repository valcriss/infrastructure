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
    await session.setup(setupToken.value.trim(), username.value, password.value);
    await router.push("/hosts");
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Erreur inattendue.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
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
