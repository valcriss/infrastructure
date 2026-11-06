<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError } from "../api";
import { useSession } from "../stores/session";

const session = useSession();
const router = useRouter();
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    await session.login(username.value, password.value);
    await router.push("/hosts");
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Erreur inattendue.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
    <h1 class="text-xl font-semibold">Connexion</h1>
    <form class="mt-6 space-y-4" @submit.prevent="submit">
      <label class="block text-sm">
        <span class="font-medium">Identifiant</span>
        <input v-model="username" required autocomplete="username" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
      </label>
      <label class="block text-sm">
        <span class="font-medium">Mot de passe</span>
        <input v-model="password" type="password" required autocomplete="current-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
      </label>
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <button :disabled="busy" class="w-full rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50">
        Se connecter
      </button>
    </form>
  </section>
</template>
