<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { api, describeError, formatBytes, type RemediationStatus } from "../api";
import { statusLabel } from "../remediation";
import { useSession } from "../stores/session";
import CopyButton from "./CopyButton.vue";
import PanelCard from "./PanelCard.vue";

// Images du registre privé : liste, usages qui les protègent et suppression manuelle (administrateur).
interface UsageRef { stackId: string; stackName: string; revision: number; kind: "current" | "deployed" | "history" }
interface RegistryImage {
  digest: string;
  tags: string[];
  sizeBytes: number | null;
  kind: "patched" | "source" | "other";
  remediation: { id: string; status: string } | null;
  retention: { candidate: boolean; reason: string | null };
  blockers: string[];
  history: UsageRef[];
  deletable: boolean;
  reason: string | null;
}
interface Repository { repository: string; managed: boolean; images: RegistryImage[]; truncated: boolean }
interface View {
  registry: string;
  reachable: boolean;
  error: string | null;
  repositories: Repository[];
  truncated: boolean;
  totalBytes: number;
  gcCommand: string;
  retention: { mode: "off" | "propose" | "auto"; keepPerRepository: number };
  retentionCandidates: number;
  containerHint: string;
}
interface GcOutcome { finishedAt: string; requestedBy: string; dryRun: boolean; status: "succeeded" | "failed" | "unknown"; error: string | null; output: string | null; usedBeforeKb: number | null; usedAfterKb: number | null }
interface GcState { running: { startedAt: string; requestedBy: string; dryRun: boolean } | null; last: GcOutcome | null; manualCommand: string }
interface RetentionState { settings: { mode: "off" | "propose" | "auto"; keepPerRepository: number; maxDeletesPerPass: number }; gc: GcState }

const session = useSession();
const view = ref<View | null>(null);
const error = ref("");
const info = ref("");
const busy = ref(false);
const gc = ref<GcState | null>(null);
const retention = reactive({ mode: "propose" as "off" | "propose" | "auto", keepPerRepository: 3, maxDeletesPerPass: 10 });
const dryRun = ref(true);
let poll: number | undefined;

const ghost = "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50";
const KIND_LABEL = { patched: "corrigée", source: "copie source", other: "autre" } as const;
const KIND_CLASS = { patched: "bg-green-100 text-green-800", source: "bg-slate-100 text-slate-700", other: "bg-slate-100 text-slate-500" } as const;

async function load() {
  busy.value = true;
  error.value = "";
  try {
    view.value = await api<View>("/api/v1/settings/registry/images");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
async function loadRetention() {
  try {
    const r = await api<RetentionState>("/api/v1/settings/registry/retention");
    Object.assign(retention, r.settings);
    gc.value = r.gc;
  } catch (err) {
    error.value = describeError(err);
  }
}
onMounted(() => {
  void load();
  void loadRetention();
  // Suivi du ramasse-miettes en cours.
  poll = window.setInterval(async () => {
    if (!gc.value?.running) return;
    try {
      const was = gc.value;
      gc.value = await api<GcState>("/api/v1/settings/registry/gc");
      if (was.running && !gc.value.running) void load();
    } catch {
      /* prochain essai */
    }
  }, 2000);
});
onBeforeUnmount(() => window.clearInterval(poll));

async function saveRetention() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await api<RetentionState>("/api/v1/settings/registry/retention", { method: "PUT", body: JSON.stringify({ mode: retention.mode, keepPerRepository: Number(retention.keepPerRepository), maxDeletesPerPass: Number(retention.maxDeletesPerPass) }) });
    Object.assign(retention, r.settings);
    gc.value = r.gc;
    info.value = "Règle de rétention enregistrée.";
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
async function applyRetention() {
  const n = view.value?.retentionCandidates ?? 0;
  if (!window.confirm(`Supprimer les ${n} image(s) proposées par la règle de rétention ? C'est irréversible. Les images utilisées par une application, un conteneur ou d'anciennes révisions ne sont jamais concernées.`)) return;
  error.value = info.value = "";
  busy.value = true;
  try {
    const r = await api<{ deleted: unknown[]; failed: { reason: string }[]; remaining: number }>("/api/v1/settings/registry/retention/apply", { method: "POST" });
    const failed = r.failed.length ? `, ${r.failed.length} en échec (${r.failed[0]?.reason})` : "";
    const remaining = r.remaining ? `, ${r.remaining} restante(s) (plafond par passage)` : "";
    info.value = `${r.deleted.length} image(s) supprimée(s)${failed}${remaining}. L'espace n'est libéré qu'après le ramasse-miettes.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
async function runGc() {
  if (!dryRun.value && !window.confirm("Lancer le ramasse-miettes du registre ? Aucun correctif ne démarre pendant l'opération, et aucune publication n'est possible dans le registre.")) return;
  error.value = info.value = "";
  busy.value = true;
  try {
    gc.value = await api<GcState>("/api/v1/settings/registry/gc", { method: "POST", body: JSON.stringify({ dryRun: dryRun.value }) });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
const kb = (n: number | null): string => (n === null ? "—" : formatBytes(n * 1024));

const empty = computed(() => !!view.value?.reachable && view.value.repositories.every((r) => r.images.length === 0));
const short = (digest: string): string => digest.slice(0, 19);

async function remove(repository: string, img: RegistryImage) {
  const what = `${repository}:${img.tags.join(", ")}`;
  let acceptHistory = false;
  if (img.history.length > 0) {
    const where = img.history.map((h) => `${h.stackName} r${h.revision}`).join(", ");
    if (!window.confirm(`Des révisions plus anciennes référencent cette image (${where}). Un retour arrière vers l'une d'elles ne pourrait plus la télécharger. Supprimer quand même ?`)) return;
    acceptHistory = true;
  } else if (!window.confirm(`Supprimer l'image ${what} du registre ? Tous ses tags disparaissent ; c'est irréversible.`)) {
    return;
  }
  error.value = info.value = "";
  busy.value = true;
  try {
    await api("/api/v1/settings/registry/images/delete", { method: "POST", body: JSON.stringify({ repository, digest: img.digest, acceptHistory }) });
    info.value = `Image supprimée du registre (${what}). L'espace disque n'est libéré qu'après le ramasse-miettes du registre.`;
    view.value = await api<View>("/api/v1/settings/registry/images");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PanelCard title="Images du registre" icon="box" subtitle="Ce que contiennent les correctifs d'images ; la suppression est manuelle, ou selon la règle de rétention choisie">
    <p v-if="error" role="alert" class="mb-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="mb-2 text-sm text-green-700">{{ info }}</p>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button :class="ghost" :disabled="busy" @click="load">{{ busy ? "Lecture…" : "Actualiser" }}</button>
      <span v-if="view?.reachable" class="text-xs text-slate-500">Taille cumulée annoncée : {{ formatBytes(view.totalBytes) }} (couches partagées comptées plusieurs fois)</span>
    </div>

    <form v-if="session.isAdmin" class="mb-4 flex flex-wrap items-end gap-3 rounded border border-slate-200 p-3 text-sm" @submit.prevent="saveRetention">
      <label class="block">
        <span class="font-medium">Rétention</span>
        <select v-model="retention.mode" class="mt-1 block rounded border border-slate-300 bg-white px-2 py-1.5">
          <option value="off">Désactivée</option>
          <option value="propose">Proposer (je confirme)</option>
          <option value="auto">Supprimer automatiquement</option>
        </select>
      </label>
      <label class="block"><span class="font-medium">Correctifs conservés par dépôt</span><input v-model.number="retention.keepPerRepository" type="number" min="1" max="50" class="mt-1 block w-24 rounded border border-slate-300 px-2 py-1.5" /></label>
      <label class="block"><span class="font-medium">Maximum par passage</span><input v-model.number="retention.maxDeletesPerPass" type="number" min="1" max="50" class="mt-1 block w-24 rounded border border-slate-300 px-2 py-1.5" /></label>
      <button class="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="busy">Enregistrer</button>
      <p class="basis-full text-xs text-slate-500">
        Les N correctifs les plus récents de chaque dépôt sont conservés. Une image utilisée (révision courante ou déployée, conteneur, correctif en cours) ou référencée par d'anciennes révisions n'est jamais concernée.
        En mode automatique, la console supprime toutes les 6 h (jamais pendant un correctif) puis lance le ramasse-miettes.
      </p>
    </form>
    <p v-if="view?.reachable && view.retention.mode !== 'off' && view.retentionCandidates > 0" role="note" class="mb-3 flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
      {{ view.retentionCandidates }} image(s) proposée(s) à la suppression (au-delà des {{ view.retention.keepPerRepository }} correctifs les plus récents par dépôt).
      <button v-if="session.isAdmin" :class="ghost" :disabled="busy" @click="applyRetention">Supprimer les images proposées</button>
    </p>

    <p v-if="view && !view.reachable" role="alert" class="rounded bg-amber-50 p-2 text-sm text-amber-900">
      Le registre ne répond pas : {{ view.error }} Vérifiez que l'application est déployée (bouton « Tester l'accès »).
    </p>
    <p v-else-if="empty" class="text-sm text-slate-600">Le registre ne contient encore aucune image. Elles apparaissent après un premier correctif d'image.</p>

    <template v-if="view?.reachable">
      <p v-if="view.truncated" role="note" class="mb-2 text-xs text-amber-800">La liste est tronquée (trop de dépôts ou de tags).</p>
      <div v-for="repo in view.repositories.filter((r) => r.images.length > 0)" :key="repo.repository" class="mb-4">
        <h3 class="font-mono text-sm font-medium">
          {{ repo.repository }}
          <span v-if="!repo.managed" class="ml-1 rounded-full bg-slate-100 px-2 py-0.5 font-sans text-xs font-normal text-slate-600">hors console (lecture seule)</span>
        </h3>
        <div class="mt-1 overflow-x-auto rounded border border-slate-200">
          <table class="min-w-full text-left text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-3 py-2">Tags</th><th class="px-3 py-2">Type</th><th class="px-3 py-2">Taille</th><th class="px-3 py-2">Digest</th><th class="px-3 py-2">Usage</th><th v-if="session.isAdmin" class="px-3 py-2"><span class="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              <tr v-for="img in repo.images" :key="img.digest" class="border-t border-slate-100 align-top">
                <td class="px-3 py-1.5 font-mono text-xs">
                  {{ img.tags.join(", ") }}
                  <span v-if="img.retention.candidate" class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 font-sans text-xs font-medium text-amber-800" :title="img.retention.reason ?? ''">à nettoyer</span>
                </td>
                <td class="px-3 py-1.5">
                  <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="KIND_CLASS[img.kind]">{{ KIND_LABEL[img.kind] }}</span>
                  <span v-if="img.remediation" class="ml-1 text-xs text-slate-500">{{ statusLabel(img.remediation.status as RemediationStatus) }}</span>
                </td>
                <td class="px-3 py-1.5 text-xs">{{ img.sizeBytes === null ? "—" : formatBytes(img.sizeBytes) }}</td>
                <td class="px-3 py-1.5 font-mono text-xs">{{ short(img.digest) }}…<CopyButton :text="`${view.registry}/${repo.repository}@${img.digest}`" label="Copier la référence" /></td>
                <td class="px-3 py-1.5 text-xs">
                  <ul v-if="img.blockers.length > 0" class="space-y-0.5 text-amber-800">
                    <li v-for="b in img.blockers" :key="b">{{ b }}</li>
                  </ul>
                  <span v-else-if="img.history.length === 0" class="text-slate-500">aucun</span>
                  <ul v-if="img.history.length > 0" class="space-y-0.5 text-slate-600">
                    <li v-for="h in img.history" :key="`${h.stackId}-${h.revision}`">Ancienne révision r{{ h.revision }} de <RouterLink :to="`/stacks/${h.stackId}`" class="text-blue-600 underline">{{ h.stackName }}</RouterLink></li>
                  </ul>
                </td>
                <td v-if="session.isAdmin" class="px-3 py-1.5">
                  <button v-if="repo.managed" :class="ghost" :disabled="busy || !img.deletable" :title="img.reason ?? ''" @click="remove(repo.repository, img)">Supprimer</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="repo.truncated" class="mt-1 text-xs text-amber-800">Dépôt incomplet (trop de tags, ou lecture partielle).</p>
      </div>

      <div class="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
        <p class="font-medium">Libérer l'espace disque</p>
        <p class="mt-1">
          Supprimer une image retire ses références, pas ses données : l'espace n'est rendu qu'après le ramasse-miettes du registre. La console peut le lancer sur l'hôte du registre (commande fixe, jamais pendant un correctif ; aucun correctif ne démarre pendant l'opération).
        </p>
        <div v-if="session.isAdmin" class="mt-2 flex flex-wrap items-center gap-3">
          <button :class="ghost" :disabled="busy || !!gc?.running" @click="runGc">{{ gc?.running ? "Ramasse-miettes en cours…" : "Lancer le ramasse-miettes" }}</button>
          <label class="flex items-center gap-1"><input v-model="dryRun" type="checkbox" /> Simuler seulement (rien n'est supprimé)</label>
        </div>
        <p v-if="gc?.last" class="mt-2" :class="gc.last.status === 'succeeded' ? 'text-green-800' : 'text-red-700'" role="status">
          Dernier passage {{ gc.last.dryRun ? "(simulation) " : "" }}: {{ gc.last.status === "succeeded" ? "réussi" : gc.last.status === "unknown" ? "indéterminé" : "échoué" }}
          <template v-if="gc.last.usedBeforeKb !== null && gc.last.usedAfterKb !== null"> · espace {{ kb(gc.last.usedBeforeKb) }} → {{ kb(gc.last.usedAfterKb) }}</template>
          <template v-if="gc.last.error"> · {{ gc.last.error }}</template>
        </p>
        <pre v-if="gc?.last?.output" class="mt-1 max-h-40 overflow-auto rounded border border-slate-200 bg-white p-2 text-[11px]">{{ gc.last.output }}</pre>
        <p class="mt-2">À la main, si l'agent de l'hôte est ancien :</p>
        <p class="mt-1 font-mono">docker exec {{ view.containerHint }}-registry-1 {{ view.gcCommand }}<CopyButton :text="`docker exec ${view.containerHint}-registry-1 ${view.gcCommand}`" label="Copier la commande" /></p>
        <p class="mt-1 text-slate-500">Utilisez <code>--dry-run</code> pour voir ce qui serait supprimé sans rien effacer.</p>
        <p class="mt-1 text-slate-500">Sauvegarde : le volume <code>registry-data</code> (images) et le fichier <code>auth/htpasswd</code> de l'application contiennent l'état du registre.</p>
      </div>
    </template>
  </PanelCard>
</template>
