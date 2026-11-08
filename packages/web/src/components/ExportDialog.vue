<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { describeError, type StackDetail } from "../api";
import { useSession } from "../stores/session";

// Export d'une stack en ZIP : Compose, .env et fichiers associés de la révision active (déployée).
// Les valeurs sensibles sont omises par défaut ; un administrateur peut les inclure en confirmant son mot de passe.
const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ close: [] }>();
const session = useSession();

const includeSecrets = ref(false);
const password = ref("");
const code = ref("");
const error = ref("");
const done = ref("");
const busy = ref(false);

const active = computed(() => props.stack.deployedRevision);
const newer = computed(() => (active.value !== null && props.stack.currentRevision > active.value ? props.stack.currentRevision : null));
const passwordless = computed(() => session.isAdmin && session.info?.hasPassword === false);
const sensitiveCount = computed(() => props.stack.variables.filter((v) => v.sensitive).length + props.stack.sensitiveFiles.length);

async function download() {
  error.value = done.value = "";
  busy.value = true;
  try {
    // Compte sans mot de passe : un deuxième facteur récent tient lieu de confirmation.
    if (includeSecrets.value && passwordless.value && !session.info?.mfaRecent) {
      if (!code.value) throw new Error("Saisissez votre code à usage unique, ou utilisez une clé d'accès.");
      await session.stepUpWithCode(code.value);
    }
    const res = await fetch(`/api/v1/stacks/${props.stack.id}/export`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeSecrets: includeSecrets.value, ...(includeSecrets.value && password.value ? { password: password.value } : {}) }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(data?.error?.message ?? `Erreur ${res.status}`);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${props.stack.name}.zip`;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    password.value = code.value = "";
    done.value = `${filename} téléchargé.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function usePasskey() {
  error.value = "";
  try {
    await session.stepUpWithPasskey();
    await download();
  } catch (err) {
    error.value = describeError(err);
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

const input = "rounded border border-slate-300 px-3 py-2";
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" aria-label="Exporter la stack" class="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">Exporter « {{ stack.name }} »</h2>
          <p class="text-xs text-slate-500">Archive ZIP : docker-compose.yml, .env et fichiers associés</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div class="space-y-4 p-6 text-sm">
        <p v-if="active === null" class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Cette stack n'a jamais été déployée : il n'y a pas de révision active à exporter. Déployez-la d'abord.
        </p>
        <template v-else>
          <p>
            Exporte la <strong>révision {{ active }}</strong> (révision active, celle qui est déployée).
            <span v-if="newer !== null" class="mt-1 block text-slate-500">La révision {{ newer }} est enregistrée mais n'est pas déployée : elle n'est pas incluse.</span>
          </p>
          <p class="text-slate-600">
            Contient le Compose, le <code>.env</code>, les fichiers associés (arborescence conservée) et un <code>LISEZMOI.txt</code>.
            <template v-if="sensitiveCount">
              {{ sensitiveCount }} valeur(s) ou fichier(s) sensible(s) : <strong>non exportés</strong> par défaut (lignes vides à renseigner dans le <code>.env</code>).
            </template>
          </p>

          <div v-if="session.isAdmin" class="space-y-3 rounded border border-slate-200 p-3">
            <label class="flex items-start gap-2">
              <input v-model="includeSecrets" type="checkbox" class="mt-1" />
              <span><span class="font-medium">Inclure les valeurs sensibles</span><span class="block text-xs text-slate-500">Administrateurs seulement. Le ZIP contiendra des secrets en clair ; l'export est tracé dans l'audit.</span></span>
            </label>
            <template v-if="includeSecrets">
              <label v-if="!passwordless" class="block">
                <span class="mb-1 block font-medium">Confirmez votre mot de passe</span>
                <input v-model="password" type="password" autocomplete="current-password" :class="[input, 'w-full']" />
              </label>
              <div v-else class="space-y-2">
                <p class="text-slate-600">Votre compte n'a pas de mot de passe : confirmez avec un deuxième facteur.</p>
                <div v-if="!session.info?.mfaRecent" class="flex flex-wrap items-center gap-2">
                  <input v-model="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Code à usage unique" :class="[input, 'w-48']" />
                  <button v-if="session.info?.passkeysAvailable" type="button" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" :disabled="busy" @click="usePasskey">Utiliser une clé d'accès</button>
                </div>
                <p v-else class="text-green-700">Deuxième facteur déjà confirmé récemment.</p>
              </div>
              <p class="text-xs text-amber-700">Protégez ce fichier et supprimez-le après usage.</p>
            </template>
          </div>
        </template>
        <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>
        <p v-if="done" role="status" class="text-green-700">{{ done }}</p>
      </div>

      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">Fermer</button>
        <button :disabled="busy || active === null || (includeSecrets && !passwordless && !password)" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="download">Télécharger le ZIP</button>
      </footer>
    </div>
  </div>
</template>
