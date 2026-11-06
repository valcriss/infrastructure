<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { api, describeError, shortId, type ImageView, type RegistryEntry, type SecuritySettings } from "../api";
import ScanBadge from "../components/ScanBadge.vue";
import VulnerabilityTable from "../components/VulnerabilityTable.vue";

const images = ref<ImageView[]>([]);
const error = ref("");
const info = ref("");
const filter = ref<"" | "managed" | "never" | "vulnerable" | "failed">("");
const open = reactive<Record<string, boolean>>({});
let timer: number | undefined;

const registries = ref<RegistryEntry[]>([]);
const reg = reactive({ registry: "", username: "", password: "", insecure: false });
const regTest = reactive<Record<string, string>>({});
const settings = reactive<SecuritySettings>({ scanIntervalHours: 24, imageCheckIntervalHours: 24 });

const key = (i: ImageView) => `${i.imageId}|${i.platform}`;
const shown = computed(() =>
  images.value.filter((i) => {
    if (filter.value === "managed") return i.managed;
    if (filter.value) return i.scan.state === filter.value;
    return true;
  }),
);

async function load() {
  try {
    images.value = (await api<{ images: ImageView[] }>("/api/v1/images")).images;
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
}
async function loadConfig() {
  registries.value = (await api<{ registries: RegistryEntry[] }>("/api/v1/registries")).registries;
  Object.assign(settings, await api<SecuritySettings>("/api/v1/settings/security"));
}

async function scan(i: ImageView) {
  error.value = info.value = "";
  try {
    await api(`/api/v1/images/${encodeURIComponent(i.imageId)}/scans`, { method: "POST", body: JSON.stringify({ platform: i.platform || undefined }) });
    info.value = `Scan de ${i.refs[0] ?? shortId(i.imageId)} demandé.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function saveSettings() {
  error.value = info.value = "";
  try {
    Object.assign(settings, await api<SecuritySettings>("/api/v1/settings/security", { method: "PUT", body: JSON.stringify(settings) }));
    info.value = "Périodes enregistrées.";
  } catch (err) {
    error.value = describeError(err);
  }
}

async function saveRegistry() {
  error.value = info.value = "";
  try {
    await api(`/api/v1/registries/${encodeURIComponent(reg.registry)}`, {
      method: "PUT",
      body: JSON.stringify({ username: reg.username || null, ...(reg.password ? { password: reg.password } : {}), insecure: reg.insecure }),
    });
    reg.password = "";
    info.value = `Registre « ${reg.registry} » enregistré.`;
    await loadConfig();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function testRegistry(r: RegistryEntry) {
  regTest[r.registry] = "Test en cours…";
  try {
    const res = await api<{ ok: boolean; message?: string }>(`/api/v1/registries/${encodeURIComponent(r.registry)}/test`, { method: "POST" });
    regTest[r.registry] = res.ok ? "Accès valide." : (res.message ?? "Échec.");
  } catch (err) {
    regTest[r.registry] = describeError(err);
  }
}

async function removeRegistry(r: RegistryEntry) {
  if (!confirm(`Supprimer les identifiants du registre « ${r.registry} » ?`)) return;
  try {
    await api(`/api/v1/registries/${encodeURIComponent(r.registry)}`, { method: "DELETE" });
    await loadConfig();
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => {
  void load();
  void loadConfig();
  timer = window.setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-10">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Images et sécurité</h1>
      <label class="text-sm">
        <span class="sr-only">Filtre</span>
        <select v-model="filter" aria-label="Filtre" class="rounded border border-slate-300 bg-white px-3 py-1.5">
          <option value="">Toutes les images</option>
          <option value="managed">Images de stacks gérées</option>
          <option value="never">Jamais scannées</option>
          <option value="failed">Scan en échec</option>
          <option value="vulnerable">Avec vulnérabilités</option>
        </select>
      </label>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>

    <section aria-label="Images">
      <p v-if="shown.length === 0" class="text-sm text-slate-500">Aucune image. Elles apparaissent dès que des conteneurs sont observés sur un hôte.</p>
      <ul class="space-y-3">
        <li v-for="i in shown" :key="key(i)" class="rounded-lg border border-slate-200 bg-white p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="break-all font-mono text-sm font-medium">{{ i.refs[0] ?? shortId(i.imageId) }}</p>
              <p class="text-xs text-slate-400">{{ i.platform || "plateforme inconnue" }} · {{ shortId(i.imageId) }}<span v-if="!i.managed"> · hors stack gérée</span></p>
              <p class="mt-1 text-xs text-slate-600">
                Utilisée par
                <template v-for="(u, n) in i.usedBy" :key="u.containerId + u.hostId">
                  <template v-if="n">, </template>
                  <RouterLink v-if="u.stackId" :to="`/stacks/${u.stackId}`" class="underline">{{ u.stackName }}/{{ u.service }}</RouterLink>
                  <span v-else>{{ u.container }}</span>
                  <span class="text-slate-400"> ({{ u.hostName }}{{ u.state !== "running" ? ", " + u.state : "" }})</span>
                </template>
              </p>
            </div>
            <div class="flex items-start gap-3">
              <ScanBadge :scan="i.scan" />
              <button class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" @click="scan(i)">Scanner</button>
            </div>
          </div>
          <div v-if="i.scan.current?.total" class="mt-3 text-sm">
            <button class="underline" :aria-expanded="!!open[key(i)]" @click="open[key(i)] = !open[key(i)]">{{ open[key(i)] ? "Masquer" : "Voir" }} les vulnérabilités</button>
            <div v-if="open[key(i)]" class="mt-3"><VulnerabilityTable :image-id="i.imageId" :platform="i.platform" /></div>
          </div>
        </li>
      </ul>
    </section>

    <section aria-label="Planification" class="max-w-xl rounded-lg border border-slate-200 bg-white p-6">
      <h2 class="text-lg font-semibold">Planification</h2>
      <p class="mt-1 text-sm text-slate-600">Les scans sont refaits régulièrement car la base de vulnérabilités évolue. 0 désactive la planification. Aucun déploiement n'est jamais bloqué par un résultat.</p>
      <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="saveSettings">
        <label class="text-sm"><span class="font-medium">Scans (heures)</span><input v-model.number="settings.scanIntervalHours" type="number" min="0" max="720" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
        <label class="text-sm"><span class="font-medium">Recherche de versions (heures)</span><input v-model.number="settings.imageCheckIntervalHours" type="number" min="0" max="720" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
        <div class="sm:col-span-2"><button class="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700">Enregistrer</button></div>
      </form>
    </section>

    <section aria-label="Registres" class="max-w-3xl rounded-lg border border-slate-200 bg-white p-6">
      <h2 class="text-lg font-semibold">Registres d'images</h2>
      <p class="mt-1 text-sm text-slate-600">
        Nécessaires pour surveiller les nouvelles versions d'images privées (Docker Hub, GHCR et tout registre compatible API v2). Les identifiants sont chiffrés, jamais affichés ni sauvegardés dans Git, et envoyés uniquement au service d'authentification du registre.
        Le registre doit être joignable depuis la console.
      </p>
      <ul v-if="registries.length" class="mt-4 divide-y divide-slate-100 text-sm">
        <li v-for="r in registries" :key="r.registry" class="flex flex-wrap items-center justify-between gap-2 py-2">
          <div>
            <span class="font-mono">{{ r.registry }}</span>
            <span class="ml-2 text-xs text-slate-500">{{ r.username ? `compte ${r.username}` : "anonyme" }}{{ r.insecure ? " · HTTP non sécurisé" : "" }}</span>
            <p v-if="regTest[r.registry]" class="text-xs text-slate-600" aria-live="polite">{{ regTest[r.registry] }}</p>
          </div>
          <div class="flex gap-2 text-xs">
            <button class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="testRegistry(r)">Tester</button>
            <button class="rounded border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50" @click="removeRegistry(r)">Supprimer</button>
          </div>
        </li>
      </ul>
      <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="saveRegistry">
        <label class="text-sm"><span class="font-medium">Registre</span><input v-model="reg.registry" required placeholder="ghcr.io ou registre.exemple.org:5000" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
        <label class="text-sm"><span class="font-medium">Identifiant (facultatif)</span><input v-model="reg.username" autocomplete="off" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
        <label class="text-sm"><span class="font-medium">Mot de passe ou jeton</span><input v-model="reg.password" type="password" autocomplete="new-password" placeholder="inchangé si vide" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
        <label class="flex items-center gap-2 self-end text-sm"><input v-model="reg.insecure" type="checkbox" /> Registre interne en HTTP (sans TLS)</label>
        <div class="sm:col-span-2"><button class="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700">Enregistrer le registre</button></div>
      </form>
    </section>
  </div>
</template>
