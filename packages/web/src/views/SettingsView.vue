<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiError, api } from "../api";
import { useSession } from "../stores/session";

const session = useSession();
const currentPassword = ref("");
const newUsername = ref("");
const newPassword = ref("");
const confirm = ref("");
const error = ref("");
const ok = ref("");
const busy = ref(false);
const recipient = ref<string | null>(null);

onMounted(async () => {
  recipient.value = (await api<{ recipient: string | null }>("/api/v1/admin/restoration-key")).recipient;
});

async function submit() {
  error.value = "";
  ok.value = "";
  if (!newUsername.value && !newPassword.value) {
    error.value = "Renseignez un nouvel identifiant ou un nouveau mot de passe.";
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
  <div class="space-y-8">
    <h1 class="text-2xl font-semibold">Paramètres</h1>

    <section class="max-w-md rounded-lg border border-slate-200 bg-white p-6">
      <h2 class="text-lg font-semibold">Compte administrateur</h2>
      <form class="mt-4 space-y-4" @submit.prevent="submit">
        <label class="block text-sm">
          <span class="font-medium">Mot de passe actuel</span>
          <input v-model="currentPassword" type="password" required autocomplete="current-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Nouvel identifiant (optionnel)</span>
          <input v-model="newUsername" minlength="3" autocomplete="username" :placeholder="session.username ?? ''" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Nouveau mot de passe (optionnel, 12 caractères minimum)</span>
          <input v-model="newPassword" type="password" autocomplete="new-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Confirmation</span>
          <input v-model="confirm" type="password" autocomplete="new-password" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <p v-if="ok" role="status" class="text-sm text-green-700">{{ ok }}</p>
        <button :disabled="busy" class="rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50">
          Enregistrer
        </button>
      </form>
    </section>

    <section class="max-w-xl rounded-lg border border-slate-200 bg-white p-6">
      <h2 class="text-lg font-semibold">Clé de restauration</h2>
      <p class="mt-2 text-sm text-slate-600">
        Seule la clé publique est conservée par la console. La clé privée n'a été montrée qu'une fois, à l'initialisation.
      </p>
      <code v-if="recipient" class="mt-3 block break-all rounded bg-slate-100 px-3 py-2 font-mono text-xs">{{ recipient }}</code>
    </section>
  </div>
</template>
