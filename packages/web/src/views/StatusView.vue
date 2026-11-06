<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ago, api, fmtDate, formatBytes, type BackupState, type BackupStatus, type Dashboard, type ImageView, type OverviewResult } from "../api";
import MeterBar from "../components/MeterBar.vue";
import PanelCard from "../components/PanelCard.vue";

const dash = ref<Dashboard | null>(null);
const backup = ref<BackupStatus | null>(null);
const overview = ref<OverviewResult | null>(null);
const images = ref<ImageView[]>([]);
const error = ref("");
const now = ref(Date.now());
let timer: number | undefined;

async function load() {
  try {
    const [d, b, o, i] = await Promise.all([
      api<Dashboard>("/api/v1/dashboard"),
      api<BackupStatus>("/api/v1/backup/status"),
      api<OverviewResult>("/api/v1/dashboard/overview?range=1h"),
      api<{ images: ImageView[] }>("/api/v1/images"),
    ]);
    dash.value = d;
    backup.value = b;
    overview.value = o;
    images.value = i.images;
    now.value = Date.now();
    error.value = "";
  } catch {
    error.value = "Chargement impossible : la console ne répond pas.";
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const BACKUP: Record<BackupState, { text: string; tone: "ok" | "warn" | "bad" | "mute"; icon: string }> = {
  ok: { text: "À jour", tone: "ok", icon: "circle-check" },
  pending: { text: "En attente de push", tone: "warn", icon: "clock" },
  error: { text: "En échec", tone: "bad", icon: "circle-xmark" },
  blocked: { text: "Bloquée (divergence)", tone: "bad", icon: "triangle-exclamation" },
  disabled: { text: "Désactivée", tone: "mute", icon: "circle-info" },
  not_configured: { text: "Non configurée", tone: "mute", icon: "circle-info" },
};
const TONE_CLS = { ok: "text-green-600", warn: "text-amber-500", bad: "text-red-600", mute: "text-slate-400" } as const;

const resources = (hostId: string) => overview.value?.hosts.find((h) => h.hostId === hostId)?.latest ?? null;
const pct = (used: number | null | undefined, total: number | null | undefined): number | null => (used === null || used === undefined || !total ? null : (used / total) * 100);

// Fraîcheur de la base de vulnérabilités : le scan réussi le plus récent la renseigne.
const trivy = computed(() => {
  const scans = images.value.map((i) => i.scan.current).filter((s): s is NonNullable<typeof s> => s !== null && s !== undefined);
  scans.sort((a, b) => Date.parse(b.finishedAt ?? "") - Date.parse(a.finishedAt ?? ""));
  return scans[0] ?? null;
});

const warnings = computed(() => {
  const list: string[] = [];
  const warn = dash.value?.alerts.filter((a) => a.severity === "warning").length ?? 0;
  if (warn) list.push(`${warn} alerte(s) d'attention`);
  if (backup.value && ["not_configured", "disabled", "pending"].includes(backup.value.state)) list.push("sauvegarde Git non à jour");
  return list;
});

const problems = computed(() => {
  const list: string[] = [];
  if (dash.value && dash.value.agents.offline > 0) list.push(`${dash.value.agents.offline} agent(s) hors ligne`);
  if (backup.value && ["error", "blocked"].includes(backup.value.state)) list.push("sauvegarde Git en défaut");
  const crit = dash.value?.alerts.filter((a) => a.severity === "critical").length ?? 0;
  if (crit) list.push(`${crit} alerte(s) critique(s)`);
  return list;
});
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Statut</h1>
      <p class="text-sm text-slate-500">Agents, hôtes, sauvegarde et sécurité en un coup d'œil. Mise à jour toutes les 10 secondes.</p>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>

    <template v-if="dash && backup">
      <div :class="['flex items-center gap-3 rounded-xl border p-4', problems.length ? 'border-red-300 bg-red-50 text-red-900' : warnings.length ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-green-300 bg-green-50 text-green-900']">
        <FaIcon :icon="['fas', problems.length || warnings.length ? 'triangle-exclamation' : 'circle-check']" class="text-2xl" />
        <p class="font-medium">
          {{ problems.length ? `Problème : ${problems.join(" · ")}` : warnings.length ? `À surveiller : ${warnings.join(" · ")}` : "Tout fonctionne : agents en ligne, sauvegarde à jour." }}
        </p>
      </div>

      <PanelCard title="Hôtes et agents" icon="server">
        <p v-if="dash.agents.items.length === 0" class="text-sm text-slate-500">Aucun agent enrôlé.</p>
        <ul class="divide-y divide-slate-200">
          <li v-for="a in dash.agents.items" :key="a.id" class="grid gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div>
              <p class="flex items-center gap-2 font-medium">
                <span :class="['inline-block h-2.5 w-2.5 rounded-full', a.presence === 'online' ? 'bg-green-500' : 'bg-red-500']" aria-hidden="true"></span>
                {{ a.name }}
                <span :class="['rounded px-1.5 py-0.5 text-xs font-normal', a.presence === 'online' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800']">{{ a.presence === "online" ? "en ligne" : "hors ligne" }}</span>
              </p>
              <p class="mt-1 text-xs text-slate-500">
                {{ a.presence === "online" ? "Connecté" : "Vu" }} <span :title="fmtDate(a.lastSeenAt)">{{ ago(a.lastSeenAt, now) }}</span>
                · Docker {{ a.dockerVersion ?? "?" }} · agent {{ a.agentVersion ?? "?" }}
              </p>
              <p v-if="a.hostInfo" class="text-xs text-slate-500">{{ a.hostInfo.os }} · {{ a.hostInfo.cpus }} cœur(s) · {{ formatBytes(a.hostInfo.memTotalBytes) }} · {{ a.hostInfo.containersRunning }} conteneur(s) en marche · {{ a.hostInfo.images }} image(s)</p>
            </div>
            <div v-if="resources(a.id)" class="space-y-2">
              <MeterBar label="CPU" icon="microchip" :percent="resources(a.id)?.cpuPercent ?? null" />
              <MeterBar label="Mémoire" icon="memory" :percent="pct(resources(a.id)?.memUsed, resources(a.id)?.memTotal)" :detail="resources(a.id)?.memTotal ? `${formatBytes(resources(a.id)?.memUsed ?? 0)} / ${formatBytes(resources(a.id)?.memTotal ?? 0)}` : undefined" />
              <MeterBar label="Disque" icon="hard-drive" :percent="pct(resources(a.id)?.diskUsed, resources(a.id)?.diskTotal)" :detail="resources(a.id)?.diskTotal ? `${formatBytes(resources(a.id)?.diskUsed ?? 0)} / ${formatBytes(resources(a.id)?.diskTotal ?? 0)}` : undefined" />
            </div>
            <p v-else class="self-center text-xs text-slate-500">Pas de relevé de la machine pour le moment.</p>
          </li>
        </ul>
      </PanelCard>

      <div class="grid gap-4 xl:grid-cols-2">
        <PanelCard title="Sauvegarde Git" icon="cloud-arrow-up">
          <p :class="['flex items-center gap-2 text-lg font-semibold', TONE_CLS[BACKUP[backup.state].tone]]">
            <FaIcon :icon="['fas', BACKUP[backup.state].icon]" /> {{ BACKUP[backup.state].text }}
          </p>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <template v-if="backup.configured">
              <dt class="text-slate-500">Dépôt</dt><dd class="truncate">{{ backup.repoUrl }} <span class="text-slate-400">({{ backup.branch }})</span></dd>
              <dt class="text-slate-500">Dernier push</dt><dd :title="fmtDate(backup.lastPushAt)">{{ backup.lastPushAt ? ago(backup.lastPushAt, now) : "jamais" }}</dd>
              <dt class="text-slate-500">Révisions en attente</dt><dd>{{ backup.pendingRevisions }}</dd>
              <dt class="text-slate-500">Clé de restauration</dt><dd>{{ backup.hasRestorationKey ? "présente" : "absente" }}</dd>
            </template>
            <template v-else><dt class="col-span-2 text-slate-500">Aucun dépôt configuré : la configuration n'est pas sauvegardée hors de cette console.</dt></template>
          </dl>
          <p v-if="backup.lastError" class="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{{ backup.lastError.message }}</p>
          <RouterLink to="/settings?tab=git" class="mt-4 inline-block text-sm text-blue-600 underline">Gérer la sauvegarde</RouterLink>
        </PanelCard>

        <PanelCard title="Sécurité des images" icon="shield-halved">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-slate-500">Images des applications</dt><dd>{{ dash.security.images.images }}</dd>
            <dt class="text-slate-500">Sans CVE critique ni élevée</dt><dd>{{ dash.security.images.noSevere }}</dd>
            <dt class="text-slate-500">Avec CVE critiques ou élevées</dt><dd>{{ dash.security.images.withCritical + dash.security.images.withHigh }} ({{ dash.security.images.critical }} critique(s), {{ dash.security.images.high }} élevée(s))</dd>
            <dt class="text-slate-500">Jamais scannées</dt><dd>{{ dash.security.images.never }}</dd>
            <dt class="text-slate-500">Scans en échec</dt><dd :class="dash.security.images.failed ? 'font-medium text-red-600' : ''">{{ dash.security.images.failed }}</dd>
            <dt class="text-slate-500">Base de vulnérabilités</dt>
            <dd>{{ trivy?.dbUpdatedAt ? `du ${new Date(trivy.dbUpdatedAt).toLocaleDateString("fr-FR")}` : "inconnue (aucun scan abouti)" }}<span v-if="trivy?.trivyVersion" class="text-slate-400"> · Trivy {{ trivy.trivyVersion }}</span></dd>
            <dt class="text-slate-500">Mises à jour d'images</dt><dd>{{ dash.security.updates.available }} disponible(s)<span v-if="dash.security.updates.errors"> · {{ dash.security.updates.errors }} vérification(s) impossible(s)</span></dd>
          </dl>
          <RouterLink to="/images" class="mt-4 inline-block text-sm text-blue-600 underline">Voir les images</RouterLink>
        </PanelCard>
      </div>
    </template>
  </div>
</template>
