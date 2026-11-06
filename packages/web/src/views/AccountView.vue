<script setup lang="ts">
import { ref } from "vue";
import { ApiError } from "../api";
import PageTitle from "../components/PageTitle.vue";
import PanelCard from "../components/PanelCard.vue";
import { useSession } from "../stores/session";

// Paramètres de l'utilisateur (il n'y a qu'un compte administrateur) : mot de passe et identifiant.
const session = useSession();
const currentPassword = ref("");
const newUsername = ref("");
const newPassword = ref("");
const confirm = ref("");
const error = ref("");
const ok = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  ok.value = "";
  if (!newUsername.value && !newPassword.value) {
    error.value = "Renseignez un nouveau mot de passe (ou un nouvel identifiant).";
    return;
  }
  if (newPassword.value && newPassword.value.length < 12) {
    error.value = "Le mot de passe doit contenir au moins 12 caractères.";
    return;
  }
  if (newPassword.value !== confirm.value) {
    error.value = "Les mots de passe ne correspondent pas.";
    return;
  }
  busy.value = true;
  try {
    await session.changeCredentials({
      currentPassword: currentPassword.value,
      ...(newUsername.value ? { newUsername: newUsername.value } : {}),
      ...(newPassword.value ? { newPassword: newPassword.value } : {}),
    });
    ok.value = "Identifiants mis à jour. Les autres sessions ont été déconnectées.";
    currentPassword.value = newUsername.value = newPassword.value = confirm.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Erreur inattendue.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageTitle title="Mes paramètres" icon="user" :subtitle="`Compte : ${session.username ?? ''}`" />

    <div class="grid items-start gap-4 xl:grid-cols-2">
      <PanelCard title="Mot de passe" icon="key" subtitle="Les autres sessions sont déconnectées après le changement">
        <form class="space-y-4" @submit.prevent="submit">
          <label class="block text-sm">
            <span class="font-medium">Mot de passe actuel</span>
            <input v-model="currentPassword" type="password" required autocomplete="current-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Nouveau mot de passe (12 caractères minimum)</span>
            <input v-model="newPassword" type="password" autocomplete="new-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Confirmation</span>
            <input v-model="confirm" type="password" autocomplete="new-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Nouvel identifiant (facultatif)</span>
            <input v-model="newUsername" minlength="3" autocomplete="username" :placeholder="session.username ?? ''" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
          </label>
          <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
          <p v-if="ok" role="status" class="text-sm text-green-700">{{ ok }}</p>
          <button :disabled="busy" class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Enregistrer</button>
        </form>
      </PanelCard>
    </div>
  </div>
</template>
