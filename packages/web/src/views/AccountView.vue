<script setup lang="ts">
import { startRegistration } from "@simplewebauthn/browser";
import QRCode from "qrcode";
import { onMounted, ref } from "vue";
import { ApiError, ROLE_LABELS, api, describeError, fmtDate, type SecurityInfo } from "../api";
import PageTitle from "../components/PageTitle.vue";
import PanelCard from "../components/PanelCard.vue";
import { useSession } from "../stores/session";

// Paramètres de l'utilisateur connecté : mot de passe, code à usage unique, clés d'accès, codes de secours.
const session = useSession();
const info = ref<SecurityInfo | null>(null);
const input = "mt-1 w-full rounded border border-slate-300 px-3 py-2";
const button = "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const ghost = "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50";

async function load() {
  info.value = await api<SecurityInfo>("/api/v1/me/security");
}
onMounted(() => void load());

// --- Mot de passe ---------------------------------------------------------------------------------------
const currentPassword = ref("");
const newEmail = ref("");
const newPassword = ref("");
const confirm = ref("");
const pwError = ref("");
const pwOk = ref("");
const busy = ref(false);

async function changePassword() {
  pwError.value = pwOk.value = "";
  if (!newEmail.value && !newPassword.value) {
    pwError.value = "Renseignez un nouveau mot de passe (ou un nouvel e-mail).";
    return;
  }
  if (newPassword.value && newPassword.value.length < 12) {
    pwError.value = "Le mot de passe doit contenir au moins 12 caractères.";
    return;
  }
  if (newPassword.value !== confirm.value) {
    pwError.value = "Les mots de passe ne correspondent pas.";
    return;
  }
  busy.value = true;
  try {
    await session.changeCredentials({
      currentPassword: currentPassword.value,
      ...(newEmail.value ? { newEmail: newEmail.value } : {}),
      ...(newPassword.value ? { newPassword: newPassword.value } : {}),
    });
    pwOk.value = "Identifiants mis à jour. Les autres sessions ont été déconnectées.";
    currentPassword.value = newEmail.value = newPassword.value = confirm.value = "";
    await load();
  } catch (err) {
    pwError.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- Code à usage unique (TOTP) -----------------------------------------------------------------------
const totp = ref<{ secret: string; qr: string } | null>(null);
const totpCode = ref("");
const totpError = ref("");
const recoveryCodes = ref<string[]>([]);
const confirmPassword = ref("");

async function startTotp() {
  totpError.value = "";
  try {
    const r = await api<{ secret: string; otpauthUrl: string }>("/api/v1/me/totp", { method: "POST" });
    totp.value = { secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 192 }) };
  } catch (err) {
    totpError.value = describeError(err);
  }
}
async function confirmTotp() {
  totpError.value = "";
  try {
    const r = await api<{ recoveryCodes: string[] }>("/api/v1/me/totp/confirm", { method: "POST", body: JSON.stringify({ code: totpCode.value }) });
    recoveryCodes.value = r.recoveryCodes;
    totp.value = null;
    totpCode.value = "";
    await session.refresh();
    await load();
  } catch (err) {
    totpError.value = describeError(err);
  }
}
async function disableTotp() {
  totpError.value = "";
  try {
    await api("/api/v1/me/totp", { method: "DELETE", body: JSON.stringify({ currentPassword: confirmPassword.value }) });
    confirmPassword.value = "";
    await session.refresh();
    await load();
  } catch (err) {
    totpError.value = describeError(err);
  }
}
async function newRecoveryCodes() {
  totpError.value = "";
  try {
    const r = await api<{ recoveryCodes: string[] }>("/api/v1/me/recovery-codes", { method: "POST", body: JSON.stringify({ currentPassword: confirmPassword.value }) });
    recoveryCodes.value = r.recoveryCodes;
    confirmPassword.value = "";
    await load();
  } catch (err) {
    totpError.value = describeError(err);
  }
}

// --- Clés d'accès ---------------------------------------------------------------------------------------
const keyName = ref("");
const keyError = ref("");

async function addPasskey() {
  keyError.value = "";
  if (!keyName.value.trim()) {
    keyError.value = "Donnez un nom à cette clé (par exemple « iPhone de Daniel »).";
    return;
  }
  try {
    const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/api/v1/me/passkeys/options", { method: "POST" });
    const response = await startRegistration({ optionsJSON: options });
    await api("/api/v1/me/passkeys", { method: "POST", body: JSON.stringify({ challengeId, name: keyName.value.trim(), response }) });
    keyName.value = "";
    await session.refresh();
    await load();
  } catch (err) {
    keyError.value = err instanceof ApiError ? err.message : "Enregistrement annulé ou refusé par l'appareil.";
  }
}
async function renamePasskey(id: string, current: string) {
  const name = window.prompt("Nouveau nom de la clé", current)?.trim();
  if (!name || name === current) return;
  try {
    await api(`/api/v1/me/passkeys/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    await load();
  } catch (err) {
    keyError.value = describeError(err);
  }
}
async function removePasskey(id: string, name: string) {
  if (!window.confirm(`Supprimer la clé « ${name} » ? Elle ne permettra plus de se connecter.`)) return;
  try {
    await api(`/api/v1/me/passkeys/${id}`, { method: "DELETE" });
    await load();
  } catch (err) {
    keyError.value = describeError(err);
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageTitle title="Mes paramètres" icon="user" :subtitle="`${session.info?.email ?? ''} · ${session.info ? ROLE_LABELS[session.info.role] : ''}${session.info?.terminalAllowed ? ' · droit Terminal' : ''}`" />

    <p v-if="session.info?.mustChangePassword" role="alert" class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      Votre mot de passe est provisoire : choisissez-en un nouveau pour continuer.
    </p>

    <div class="grid items-start gap-4 xl:grid-cols-2">
      <PanelCard title="Mot de passe et e-mail" icon="key" subtitle="Les autres sessions sont déconnectées après le changement">
        <form class="space-y-4" @submit.prevent="changePassword">
          <label class="block text-sm">
            <span class="font-medium">Mot de passe actuel</span>
            <input v-model="currentPassword" type="password" required autocomplete="current-password" :class="input" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Nouveau mot de passe (12 caractères minimum)</span>
            <input v-model="newPassword" type="password" autocomplete="new-password" :class="input" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Confirmation</span>
            <input v-model="confirm" type="password" autocomplete="new-password" :class="input" />
          </label>
          <label class="block text-sm">
            <span class="font-medium">Nouvel e-mail (facultatif)</span>
            <input v-model="newEmail" type="email" autocomplete="email" :placeholder="session.info?.email ?? ''" :class="input" />
          </label>
          <p v-if="pwError" role="alert" class="text-sm text-red-700">{{ pwError }}</p>
          <p v-if="pwOk" role="status" class="text-sm text-green-700">{{ pwOk }}</p>
          <button :disabled="busy" :class="button">Enregistrer</button>
        </form>
      </PanelCard>

      <div class="space-y-4">
        <PanelCard title="Code à usage unique (TOTP)" icon="shield-halved" subtitle="Application d'authentification : obligatoire avec le droit Terminal (ou une clé d'accès)">
          <div v-if="!info" class="text-sm text-slate-500">Chargement…</div>
          <template v-else-if="!info.totpEnabled && !totp">
            <p class="text-sm text-slate-600">Non configuré.</p>
            <button :class="[button, 'mt-3']" @click="startTotp">Configurer</button>
          </template>
          <template v-else-if="totp">
            <p class="text-sm text-slate-600">Scannez ce code avec votre application d'authentification, puis saisissez le code affiché.</p>
            <img :src="totp.qr" alt="QR code à scanner" class="my-3 h-48 w-48 rounded border border-slate-200 bg-white p-1" />
            <p class="text-xs text-slate-500">Ou saisissez cette clé : <code class="select-all break-all font-mono text-slate-700">{{ totp.secret }}</code></p>
            <form class="mt-3 flex gap-2" @submit.prevent="confirmTotp">
              <input v-model="totpCode" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required class="w-32 rounded border border-slate-300 px-3 py-2 text-sm" />
              <button :class="button">Activer</button>
            </form>
          </template>
          <template v-else>
            <p class="text-sm text-green-700">Activé · {{ info.recoveryCodesRemaining }} code(s) de secours restant(s).</p>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <input v-model="confirmPassword" type="password" placeholder="Mot de passe actuel" autocomplete="current-password" class="rounded border border-slate-300 px-3 py-2 text-sm" />
              <button :class="ghost" :disabled="!confirmPassword" @click="newRecoveryCodes">Nouveaux codes de secours</button>
              <button :class="ghost" :disabled="!confirmPassword" @click="disableTotp">Désactiver</button>
            </div>
          </template>
          <div v-if="recoveryCodes.length" class="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
            <p class="font-medium text-amber-900">Codes de secours : notez-les maintenant, ils ne seront plus affichés.</p>
            <ul class="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
              <li v-for="c in recoveryCodes" :key="c">{{ c }}</li>
            </ul>
            <p class="mt-2 text-xs text-amber-800">Chaque code ne sert qu'une fois, à la place du code à usage unique.</p>
          </div>
          <p v-if="totpError" role="alert" class="mt-2 text-sm text-red-700">{{ totpError }}</p>
        </PanelCard>

        <PanelCard title="Clés d'accès" icon="key" subtitle="Téléphone, ordinateur ou clé de sécurité : connexion sans mot de passe (l'e-mail reste demandé)">
          <p v-if="!session.info?.passkeysAvailable" class="text-sm text-slate-500">
            Non disponibles : l'administrateur doit configurer <code>WEBAUTHN_RP_ID</code> et <code>WEBAUTHN_ORIGIN</code> sur la console.
          </p>
          <template v-else>
            <ul v-if="info?.passkeys.length" class="divide-y divide-slate-200 text-sm">
              <li v-for="k in info.passkeys" :key="k.id" class="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span class="font-medium">{{ k.name }}</span>
                  <span class="block text-xs text-slate-500">ajoutée {{ fmtDate(k.createdAt) }} · {{ k.lastUsedAt ? `utilisée ${fmtDate(k.lastUsedAt)}` : "jamais utilisée" }}</span>
                </span>
                <span class="flex gap-2">
                  <button :class="ghost" @click="renamePasskey(k.id, k.name)">Renommer</button>
                  <button :class="ghost" @click="removePasskey(k.id, k.name)">Supprimer</button>
                </span>
              </li>
            </ul>
            <p v-else class="text-sm text-slate-500">Aucune clé enregistrée.</p>
            <form class="mt-3 flex flex-wrap gap-2" @submit.prevent="addPasskey">
              <input v-model="keyName" placeholder="Nom de la clé (ex. iPhone de Daniel)" maxlength="60" class="min-w-56 flex-1 rounded border border-slate-300 px-3 py-2 text-sm" />
              <button :class="button">Ajouter une clé</button>
            </form>
            <p v-if="keyError" role="alert" class="mt-2 text-sm text-red-700">{{ keyError }}</p>
          </template>
        </PanelCard>
      </div>
    </div>
  </div>
</template>
