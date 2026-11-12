<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
  containerHint: string;
}

const session = useSession();
const view = ref<View | null>(null);
const error = ref("");
const info = ref("");
const busy = ref(false);

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
onMounted(load);

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
  <PanelCard title="Images du registre" icon="box" subtitle="Ce que contiennent les correctifs d'images ; rien n'est supprimé automatiquement">
    <p v-if="error" role="alert" class="mb-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="mb-2 text-sm text-green-700">{{ info }}</p>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button :class="ghost" :disabled="busy" @click="load">{{ busy ? "Lecture…" : "Actualiser" }}</button>
      <span v-if="view?.reachable" class="text-xs text-slate-500">Taille cumulée annoncée : {{ formatBytes(view.totalBytes) }} (couches partagées comptées plusieurs fois)</span>
    </div>

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
                <td class="px-3 py-1.5 font-mono text-xs">{{ img.tags.join(", ") }}</td>
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
          Supprimer une image retire ses références, pas ses données : l'espace n'est rendu qu'après le ramasse-miettes du registre. Lancez-le depuis un terminal de l'hôte (de préférence quand aucun correctif n'est en cours) :
        </p>
        <p class="mt-1 font-mono">docker exec {{ view.containerHint }}-registry-1 {{ view.gcCommand }}<CopyButton :text="`docker exec ${view.containerHint}-registry-1 ${view.gcCommand}`" label="Copier la commande" /></p>
        <p class="mt-1 text-slate-500">Utilisez <code>--dry-run</code> pour voir ce qui serait supprimé sans rien effacer.</p>
        <p class="mt-1 text-slate-500">Sauvegarde : le volume <code>registry-data</code> (images) et le fichier <code>auth/htpasswd</code> de l'application contiennent l'état du registre.</p>
      </div>
    </template>
  </PanelCard>
</template>
