<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ROLE_LABELS, api, describeError, fmtDate, type Role, type UserView } from "../../api";
import PanelCard from "../../components/PanelCard.vue";
import { useSession } from "../../stores/session";

// Gestion des utilisateurs (administrateurs) : rôles fixes, droit Terminal, réinitialisation des accès.
const session = useSession();
const users = ref<UserView[]>([]);
const error = ref("");
const secret = ref<{ email: string; password: string } | null>(null);
const input = "rounded border border-slate-300 px-3 py-2 text-sm";
const button = "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const ghost = "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50";

const form = reactive({ email: "", displayName: "", role: "viewer" as Role, terminalAllowed: false });

async function load() {
  try {
    users.value = (await api<{ users: UserView[] }>("/api/v1/users")).users;
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(() => void load());

async function create() {
  error.value = "";
  try {
    const r = await api<{ user: UserView; temporaryPassword: string }>("/api/v1/users", { method: "POST", body: JSON.stringify({ ...form }) });
    secret.value = { email: r.user.email, password: r.temporaryPassword };
    form.email = form.displayName = "";
    form.role = "viewer";
    form.terminalAllowed = false;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function patch(u: UserView, body: Partial<Pick<UserView, "role" | "terminalAllowed" | "active">>) {
  error.value = "";
  try {
    await api(`/api/v1/users/${u.id}`, { method: "PATCH", body: JSON.stringify(body) });
  } catch (err) {
    error.value = describeError(err);
  }
  await load();
}

async function reset(u: UserView) {
  if (!window.confirm(`Réinitialiser les accès de ${u.email} ? Son mot de passe, son code à usage unique et ses clés d'accès sont effacés, et ses sessions fermées.`)) return;
  error.value = "";
  try {
    const r = await api<{ temporaryPassword: string }>(`/api/v1/users/${u.id}/reset-access`, { method: "POST" });
    secret.value = { email: u.email, password: r.temporaryPassword };
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function remove(u: UserView) {
  if (!window.confirm(`Supprimer définitivement le compte ${u.email} ?`)) return;
  error.value = "";
  try {
    await api(`/api/v1/users/${u.id}`, { method: "DELETE" });
  } catch (err) {
    error.value = describeError(err);
  }
  await load();
}

const factors = (u: UserView): string => [u.totpEnabled ? "TOTP" : "", u.passkeys ? `${u.passkeys} clé(s)` : ""].filter(Boolean).join(" · ") || "aucun";
</script>

<template>
  <div class="space-y-4">
    <PanelCard title="Utilisateurs" icon="users" subtitle="Rôles fixes : lecteur (consultation), opérateur (déployer, modifier), administrateur (tout). Le droit Terminal est accordé séparément.">
      <p v-if="error" role="alert" class="mb-3 text-sm text-red-700">{{ error }}</p>
      <div v-if="secret" class="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
        <p class="font-medium text-amber-900">Mot de passe provisoire de {{ secret.email }} : communiquez-le maintenant, il ne sera plus affiché.</p>
        <p class="mt-1"><code class="select-all font-mono">{{ secret.password }}</code></p>
        <p class="mt-1 text-xs text-amber-800">Il devra être changé à la première connexion.</p>
        <button :class="[ghost, 'mt-2']" @click="secret = null">J'ai noté le mot de passe</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-slate-500">
            <tr><th class="py-1 pr-3">Utilisateur</th><th class="px-3 py-1">Rôle</th><th class="px-3 py-1">Terminal</th><th class="px-3 py-1">2<sup>e</sup> facteur</th><th class="px-3 py-1">Dernière connexion</th><th class="px-3 py-1">Actions</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" class="border-t border-slate-100" :class="{ 'opacity-60': !u.active }">
              <td class="py-2 pr-3">
                <span class="font-medium">{{ u.displayName || u.email }}</span>
                <span v-if="u.email === session.info?.email" class="ml-1 text-xs text-slate-400">(vous)</span>
                <span class="block text-xs text-slate-500">{{ u.email }}<template v-if="!u.active"> · désactivé</template><template v-if="u.mustChangePassword"> · mot de passe provisoire</template></span>
              </td>
              <td class="px-3 py-2">
                <select :value="u.role" :aria-label="`Rôle de ${u.email}`" :class="input" @change="patch(u, { role: ($event.target as HTMLSelectElement).value as Role })">
                  <option v-for="(label, r) in ROLE_LABELS" :key="r" :value="r">{{ label }}</option>
                </select>
              </td>
              <td class="px-3 py-2"><input type="checkbox" :checked="u.terminalAllowed" :aria-label="`Droit Terminal de ${u.email}`" @change="patch(u, { terminalAllowed: ($event.target as HTMLInputElement).checked })" /></td>
              <td class="px-3 py-2 text-xs text-slate-600">{{ factors(u) }}</td>
              <td class="px-3 py-2 text-xs text-slate-500">{{ u.lastLoginAt ? fmtDate(u.lastLoginAt) : "jamais" }}</td>
              <td class="px-3 py-2">
                <span class="flex flex-wrap gap-1">
                  <button :class="ghost" @click="patch(u, { active: !u.active })">{{ u.active ? "Désactiver" : "Réactiver" }}</button>
                  <button :class="ghost" @click="reset(u)">Réinitialiser</button>
                  <button :class="ghost" @click="remove(u)">Supprimer</button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </PanelCard>

    <PanelCard title="Nouvel utilisateur" icon="plus" subtitle="Un mot de passe provisoire est généré ; l'utilisateur le change à sa première connexion">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="create">
        <label class="text-sm"><span class="block font-medium">E-mail</span><input v-model="form.email" type="email" required :class="[input, 'w-64']" /></label>
        <label class="text-sm"><span class="block font-medium">Nom affiché</span><input v-model="form.displayName" maxlength="100" :class="[input, 'w-48']" /></label>
        <label class="text-sm">
          <span class="block font-medium">Rôle</span>
          <select v-model="form.role" :class="input"><option v-for="(label, r) in ROLE_LABELS" :key="r" :value="r">{{ label }}</option></select>
        </label>
        <label class="flex items-center gap-2 pb-2 text-sm"><input v-model="form.terminalAllowed" type="checkbox" /> Droit Terminal</label>
        <button :class="button">Créer</button>
      </form>
    </PanelCard>
  </div>
</template>
