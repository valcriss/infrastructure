<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api, describeError, type MinSeverity, type RegistryEntry, type SecuritySettings } from "../../api";
import AcceptedRisks from "../../components/AcceptedRisks.vue";
import PanelCard from "../../components/PanelCard.vue";

// Réglages de l'application pour la sécurité des images : périodicité des scans et registres.
const registries = ref<RegistryEntry[]>([]);
const reg = reactive({ registry: "", username: "", password: "", insecure: false });
const regTest = reactive<Record<string, string>>({});
const settings = reactive<SecuritySettings>({ scanIntervalHours: 24, imageCheckIntervalHours: 24, minSeverity: "LOW", includeUnknown: true });
const SEVERITY_CHOICES: { value: MinSeverity; label: string }[] = [
  { value: "LOW", label: "Faible et plus (tout signaler)" },
  { value: "MEDIUM", label: "Moyenne et plus" },
  { value: "HIGH", label: "Élevée et plus" },
  { value: "CRITICAL", label: "Critique uniquement" },
];
const error = ref("");
const info = ref("");

async function load() {
  try {
    registries.value = (await api<{ registries: RegistryEntry[] }>("/api/v1/registries")).registries;
    Object.assign(settings, await api<SecuritySettings>("/api/v1/settings/security"));
  } catch (err) {
    error.value = describeError(err);
  }
}

async function saveSettings() {
  error.value = info.value = "";
  try {
    Object.assign(settings, await api<SecuritySettings>("/api/v1/settings/security", { method: "PUT", body: JSON.stringify(settings) }));
    info.value = "Réglages enregistrés.";
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
    await load();
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
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>

    <div class="grid items-start gap-4 xl:grid-cols-2">
      <PanelCard title="Périodicité des scans" icon="clock">
        <p class="text-sm text-slate-600">
          Les scans sont refaits régulièrement car la base de vulnérabilités évolue, et les nouvelles versions des images sont recherchées à intervalle régulier. 0 désactive la planification. Aucun déploiement n'est jamais bloqué par un résultat.
        </p>
        <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="saveSettings">
          <label class="text-sm"><span class="font-medium">Scans de vulnérabilités (heures)</span><input v-model.number="settings.scanIntervalHours" type="number" min="0" max="720" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
          <label class="text-sm"><span class="font-medium">Recherche de nouvelles versions (heures)</span><input v-model.number="settings.imageCheckIntervalHours" type="number" min="0" max="720" class="mt-1 w-full rounded border border-slate-300 px-3 py-2" /></label>
          <div class="sm:col-span-2"><button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">Enregistrer</button></div>
        </form>
      </PanelCard>

      <PanelCard title="Vulnérabilités signalées" icon="shield-halved">
        <p class="text-sm text-slate-600">
          Choisissez à partir de quelle gravité les vulnérabilités Trivy sont comptées, affichées et utilisées pour les alertes et les graphiques. Les scans restent complets : changer ce réglage s'applique immédiatement, sans relancer de scan.
        </p>
        <form class="mt-4 space-y-3" @submit.prevent="saveSettings">
          <label class="block text-sm">
            <span class="font-medium">Gravité minimale signalée</span>
            <select v-model="settings.minSeverity" class="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2">
              <option v-for="c in SEVERITY_CHOICES" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="settings.includeUnknown" type="checkbox" />
            Signaler aussi les vulnérabilités de gravité « inconnue »
          </label>
          <button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">Enregistrer</button>
        </form>
      </PanelCard>

      <AcceptedRisks />

      <PanelCard title="Registres d'images" icon="server">
        <p class="text-sm text-slate-600">
          Nécessaires pour surveiller les nouvelles versions d'images privées (Docker Hub, GHCR et tout registre compatible API v2). Les identifiants sont chiffrés, jamais affichés ni sauvegardés dans Git, et envoyés uniquement au service d'authentification du registre. Le registre doit être joignable depuis la console.
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
          <div class="sm:col-span-2"><button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">Enregistrer le registre</button></div>
        </form>
      </PanelCard>
    </div>
  </div>
</template>
