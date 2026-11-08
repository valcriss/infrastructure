<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError } from "../api";
import { useSession } from "../stores/session";

const session = useSession();
const router = useRouter();
const email = ref("");
const password = ref("");
const code = ref("");
const needCode = ref(false);
const error = ref("");
const busy = ref(false);

async function done() {
  await router.push(session.info?.mustChangePassword ? "/account" : "/dashboard");
}

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    await session.login(email.value, password.value, needCode.value ? code.value : undefined);
    await done();
  } catch (err) {
    if (err instanceof ApiError && err.code === "mfa_required") {
      needCode.value = true;
    } else {
      error.value = err instanceof ApiError ? err.message : "Erreur inattendue.";
    }
  } finally {
    busy.value = false;
  }
}

async function usePasskey() {
  error.value = "";
  if (!email.value) {
    error.value = "Saisissez d'abord votre e-mail : il reste nécessaire avec une clé d'accès.";
    return;
  }
  busy.value = true;
  try {
    await session.loginWithPasskey(email.value);
    await done();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Connexion par clé d'accès annulée ou refusée.";
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
        <span class="font-medium">E-mail</span>
        <input v-model="email" required autocomplete="username webauthn" :readonly="needCode" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 read-only:bg-slate-100" />
      </label>
      <label class="block text-sm">
        <span class="font-medium">Mot de passe</span>
        <input v-model="password" type="password" :required="!needCode" :readonly="needCode" autocomplete="current-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 read-only:bg-slate-100" />
      </label>
      <label v-if="needCode" class="block text-sm">
        <span class="font-medium">Code à usage unique</span>
        <input v-model="code" required autofocus inputmode="numeric" autocomplete="one-time-code" placeholder="123456 ou code de secours" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        <span class="mt-1 block text-xs text-slate-500">Saisissez le code de votre application d'authentification, ou un code de secours.</span>
      </label>
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <button :disabled="busy" class="w-full rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50">
        {{ needCode ? "Valider le code" : "Se connecter" }}
      </button>
    </form>
    <div v-if="session.passkeysAvailable && !needCode" class="mt-4 border-t border-slate-200 pt-4">
      <button type="button" :disabled="busy" class="flex w-full items-center justify-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50" @click="usePasskey">
        <FaIcon :icon="['fas', 'key']" /> Se connecter avec une clé d'accès
      </button>
      <p class="mt-2 text-xs text-slate-500">Saisissez votre e-mail puis utilisez votre clé : aucun mot de passe n'est demandé.</p>
    </div>
  </section>
</template>
