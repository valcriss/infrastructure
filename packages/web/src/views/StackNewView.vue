<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, describeError, type Host } from "../api";
import YamlEditor from "../components/YamlEditor.vue";

const router = useRouter();
const hosts = ref<Host[]>([]);
const name = ref("");
const hostId = ref("");
const description = ref("");
const compose = ref(`services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "\${PUBLIC_PORT}:80"
`);
const variablesText = ref("PUBLIC_PORT=8080");
const error = ref("");
const busy = ref(false);

onMounted(async () => {
  hosts.value = (await api<{ hosts: Host[] }>("/api/v1/hosts")).hosts;
  hostId.value = hosts.value[0]?.id ?? "";
});

/** « NOM=valeur » par ligne ; les lignes vides et les commentaires sont ignorés. */
function parseVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`Ligne de variable invalide : « ${line} » (attendu NOM=valeur)`);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const variables = parseVariables(variablesText.value);
    const r = await api<{ id: string }>("/api/v1/stacks", {
      method: "POST",
      body: JSON.stringify({ name: name.value, hostId: hostId.value, description: description.value, compose: compose.value, variables }),
    });
    await router.push(`/stacks/${r.id}`);
  } catch (err) {
    error.value = err instanceof Error && !("status" in err) ? err.message : describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">Nouvelle stack</h1>
    <form class="max-w-3xl space-y-4" @submit.prevent="submit">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block text-sm">
          <span class="font-medium">Nom (nom du projet Compose)</span>
          <input v-model="name" required pattern="[a-z0-9][a-z0-9_-]*" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
        </label>
        <label class="block text-sm">
          <span class="font-medium">Hôte cible</span>
          <select v-model="hostId" required class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
            <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name }}{{ h.presence === "online" ? "" : " (hors ligne)" }}</option>
          </select>
        </label>
      </div>
      <label class="block text-sm">
        <span class="font-medium">Description (optionnelle)</span>
        <input v-model="description" maxlength="500" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" />
      </label>
      <div class="text-sm">
        <span class="font-medium">Compose</span>
        <p class="text-xs text-slate-500">Images préconstruites uniquement : « build » et « include » ne sont pas supportés.</p>
        <div class="mt-1"><YamlEditor v-model="compose" label="Fichier Compose" /></div>
      </div>
      <label class="block text-sm">
        <span class="font-medium">Variables de stack (une par ligne, NOM=valeur)</span>
        <textarea v-model="variablesText" rows="4" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"></textarea>
        <span class="text-xs text-slate-500">Les valeurs sensibles se marquent ensuite depuis l'onglet Variables.</span>
      </label>
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <div class="flex gap-3">
        <button :disabled="busy || !hostId" class="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50">Créer la stack</button>
        <RouterLink to="/stacks" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100">Annuler</RouterLink>
      </div>
      <p class="text-xs text-slate-500">La création enregistre la révision 1 sans rien déployer.</p>
    </form>
  </div>
</template>
