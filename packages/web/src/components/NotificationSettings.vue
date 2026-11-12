<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, describeError, fmtDate } from "../api";
import { useSession } from "../stores/session";
import CopyButton from "./CopyButton.vue";
import PanelCard from "./PanelCard.vue";

// Notifications par webhook HTTPS : désactivées par défaut ; adresse et secret chiffrés, jamais renvoyés par l'API.
type EventType = "remediation.ready" | "remediation.failed" | "remediation.auto_paused" | "registry.gc_failed";
interface View {
  enabled: boolean;
  baseUrl: string | null;
  events: Record<EventType, boolean>;
  allowPrivate: boolean;
  maxPerHour: number;
  configured: boolean;
  urlHost: string | null;
  hasSecret: boolean;
}
interface Delivery { id: string; at: string; event: string; status: "sent" | "failed" | "skipped"; httpStatus: number | null; durationMs: number | null; attempts: number; error: string | null }
interface Loaded { settings: View; deliveries: Delivery[] }

const EVENT_LABELS: Record<EventType, string> = {
  "remediation.ready": "Correctif préparé automatiquement, à relire",
  "remediation.failed": "Correctif refusé ou en échec",
  "remediation.auto_paused": "Préparation automatique en pause (échecs répétés)",
  "registry.gc_failed": "Ramasse-miettes du registre en échec",
};
const STATUS_LABEL = { sent: "envoyé", failed: "échec", skipped: "ignoré (plafond)" } as const;

const session = useSession();
const loaded = ref<Loaded | null>(null);
const form = reactive({ enabled: false, url: "", baseUrl: "", allowPrivate: false, maxPerHour: 20, events: { "remediation.ready": true, "remediation.failed": true, "remediation.auto_paused": true, "registry.gc_failed": true } as Record<EventType, boolean> });
const secret = ref("");
const error = ref("");
const info = ref("");
const busy = ref(false);
const canEdit = computed(() => session.isAdmin);

function fill(l: Loaded) {
  loaded.value = l;
  form.enabled = l.settings.enabled;
  form.baseUrl = l.settings.baseUrl ?? "";
  form.allowPrivate = l.settings.allowPrivate;
  form.maxPerHour = l.settings.maxPerHour;
  form.events = { ...l.settings.events };
  form.url = "";
}
async function load() {
  try {
    fill(await api<Loaded>("/api/v1/settings/notifications"));
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(load);

async function run(fn: () => Promise<void>) {
  error.value = info.value = "";
  busy.value = true;
  try {
    await fn();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const save = () =>
  run(async () => {
    // Adresse vide : inchangée (elle n'est jamais renvoyée par l'API).
    const body = { enabled: form.enabled, ...(form.url.trim() ? { url: form.url.trim() } : {}), baseUrl: form.baseUrl.trim() || null, events: form.events, allowPrivate: form.allowPrivate, maxPerHour: Number(form.maxPerHour) };
    fill(await api<Loaded>("/api/v1/settings/notifications", { method: "PUT", body: JSON.stringify(body) }));
    info.value = "Réglages enregistrés.";
  });
const removeUrl = () =>
  run(async () => {
    if (!window.confirm("Supprimer l'adresse du webhook ? Les notifications seront désactivées.")) return;
    fill(await api<Loaded>("/api/v1/settings/notifications", { method: "PUT", body: JSON.stringify({ enabled: false, url: "", baseUrl: form.baseUrl.trim() || null, events: form.events, allowPrivate: form.allowPrivate, maxPerHour: Number(form.maxPerHour) }) }));
    info.value = "Adresse supprimée.";
  });
const test = () =>
  run(async () => {
    const r = await api<{ ok: boolean; status: number | null; error: string | null; durationMs: number; deliveries: Delivery[] }>("/api/v1/settings/notifications/test", { method: "POST" });
    if (loaded.value) loaded.value.deliveries = r.deliveries;
    if (r.ok) info.value = `Message de test envoyé (HTTP ${r.status}, ${r.durationMs} ms).`;
    else error.value = `Le message de test a échoué : ${r.error ?? "erreur"}`;
  });
const reveal = () => run(async () => void (secret.value = (await api<{ secret: string }>("/api/v1/settings/notifications/secret/reveal", { method: "POST" })).secret));
const rotate = () =>
  run(async () => {
    if (!window.confirm("Renouveler le secret de signature ? L'ancien n'est plus valable : mettez à jour le destinataire.")) return;
    secret.value = (await api<{ secret: string }>("/api/v1/settings/notifications/secret/rotate", { method: "POST" })).secret;
    info.value = "Nouveau secret généré.";
  });
</script>

<template>
  <PanelCard title="Notifications (webhook)" icon="clock" subtitle="Être prévenu sans ouvrir la console ; désactivé par défaut">
    <p class="text-sm text-slate-600">
      La console peut appeler un <strong>webhook HTTPS</strong> (Slack, Discord, Teams via un flux, n8n…) pour les correctifs à relire, refusés ou en échec, la pause de la préparation automatique et un ramasse-miettes en échec.
      Les messages ne contiennent <strong>ni secret, ni valeur de variable, ni sortie d'outil</strong> : un titre, l'image, un statut et un lien.
    </p>
    <ol class="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-600" aria-label="Pour commencer">
      <li :class="loaded?.settings.configured ? 'text-green-700' : ''">Créez un <strong>webhook entrant</strong> dans votre outil (Slack, Discord, n8n…) et collez son adresse HTTPS ci-dessous.</li>
      <li>Cliquez <strong>Enregistrer</strong>, puis <strong>Envoyer un message de test</strong> : vous devez le voir arriver.</li>
      <li :class="loaded?.settings.enabled ? 'text-green-700' : ''">Cochez <strong>Envoyer les notifications</strong> et enregistrez. Choisissez les événements qui vous intéressent.</li>
      <li>Côté destinataire (facultatif) : vérifiez la signature avec le secret (« Afficher le secret de signature »).</li>
    </ol>
    <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="mt-2 text-sm text-green-700">{{ info }}</p>

    <form v-if="loaded" class="mt-4 space-y-3 text-sm" @submit.prevent="save">
      <label class="flex items-center gap-2"><input v-model="form.enabled" type="checkbox" :disabled="!canEdit" /> Envoyer les notifications</label>
      <label class="block">
        <span class="font-medium">Adresse du webhook (HTTPS)</span>
        <input v-model="form.url" type="url" autocomplete="off" :disabled="!canEdit" :placeholder="loaded.settings.configured ? `Enregistrée (${loaded.settings.urlHost}) : laisser vide pour la conserver` : 'https://hooks.exemple.fr/…'" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs" />
        <span class="text-xs text-slate-500">Chiffrée, jamais réaffichée. Les adresses locales ou privées sont refusées, et vérifiées à chaque envoi.</span>
      </label>
      <label class="block">
        <span class="font-medium">Adresse de la console (pour les liens, facultatif)</span>
        <input v-model="form.baseUrl" type="url" :disabled="!canEdit" placeholder="https://console.exemple.fr" class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs" />
      </label>
      <fieldset class="space-y-1">
        <legend class="font-medium">Événements</legend>
        <label v-for="(label, type) in EVENT_LABELS" :key="type" class="flex items-center gap-2"><input v-model="form.events[type]" type="checkbox" :disabled="!canEdit" /> {{ label }}</label>
      </fieldset>
      <label class="block">
        <span class="font-medium">Plafond d'envois par heure</span>
        <input v-model.number="form.maxPerHour" type="number" min="1" max="200" :disabled="!canEdit" class="mt-1 w-28 rounded border border-slate-300 px-3 py-2" />
      </label>
      <label class="flex items-center gap-2"><input v-model="form.allowPrivate" type="checkbox" :disabled="!canEdit" /> Autoriser une adresse privée (service interne)</label>

      <div v-if="canEdit" class="flex flex-wrap gap-2">
        <button class="rounded-md bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy">Enregistrer</button>
        <button type="button" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" :disabled="busy || !loaded.settings.configured" @click="test">Envoyer un message de test</button>
        <button type="button" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" :disabled="busy || !loaded.settings.hasSecret" @click="reveal">Afficher le secret de signature</button>
        <button type="button" class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50" :disabled="busy || !loaded.settings.hasSecret" @click="rotate">Renouveler le secret</button>
        <button v-if="loaded.settings.configured" type="button" class="rounded border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50" :disabled="busy" @click="removeUrl">Supprimer l'adresse</button>
      </div>
      <p v-else class="text-xs text-slate-500">Seul un administrateur peut modifier ces réglages.</p>
    </form>

    <div v-if="secret" class="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
      <p class="text-slate-600">Chaque envoi porte <code>X-Console-Timestamp</code> et <code>X-Console-Signature</code> = <code>sha256=</code> + HMAC-SHA256 hexadécimal de « horodatage.corps » avec ce secret. Refusez un horodatage ancien.</p>
      <p class="mt-1"><code class="break-all">{{ secret }}</code><CopyButton :text="secret" label="Copier le secret" /></p>
      <button class="mt-2 rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="secret = ''">Masquer</button>
    </div>

    <div v-if="loaded?.deliveries.length" class="mt-4">
      <h3 class="text-sm font-medium">Derniers envois</h3>
      <ul class="mt-1 divide-y divide-slate-100 rounded border border-slate-200 text-xs">
        <li v-for="d in loaded.deliveries" :key="d.id" class="flex flex-wrap items-center gap-3 px-3 py-1.5">
          <span class="font-mono">{{ d.event }}</span>
          <span :class="d.status === 'sent' ? 'text-green-700' : d.status === 'failed' ? 'text-red-700' : 'text-slate-500'">{{ STATUS_LABEL[d.status] }}</span>
          <span class="text-slate-500">{{ fmtDate(d.at) }}<template v-if="d.durationMs !== null"> · {{ d.durationMs }} ms</template><template v-if="d.attempts > 1"> · {{ d.attempts }} tentatives</template></span>
          <span v-if="d.error" class="text-slate-600">{{ d.error }}</span>
        </li>
      </ul>
    </div>
  </PanelCard>
</template>
