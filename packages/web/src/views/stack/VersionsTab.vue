<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, describeError, fmtDate } from "../../api";
import PanelCard from "../../components/PanelCard.vue";

// Historique des versions d'image d'un projet observé : un changement d'étiquette ou de contenu par ligne.
const props = defineProps<{ project: { hostId: string; name: string } }>();

interface Version { id: string; service: string; image: string; imageId: string; digest: string | null; observedAt: string }

const versions = ref<Version[]>([]);
const loaded = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    versions.value = (await api<{ versions: Version[] }>(`/api/v1/hosts/${props.project.hostId}/projects/${encodeURIComponent(props.project.name)}/versions`)).versions;
  } catch (err) {
    error.value = describeError(err);
  }
  loaded.value = true;
});

const groups = computed(() => {
  const by = new Map<string, Version[]>();
  for (const v of versions.value) by.set(v.service, [...(by.get(v.service) ?? []), v]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
});
const short = (id: string): string => (id.startsWith("sha256:") ? id.slice(7, 19) : id.slice(0, 12));
</script>

<template>
  <div class="space-y-4">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-else-if="loaded && groups.length === 0" class="text-sm text-slate-500">Aucune version enregistrée pour le moment : l'historique commence à la première observation du projet.</p>
    <PanelCard v-for="[service, list] in groups" :key="service" :title="service" icon="code-branch" :subtitle="`${list.length} version(s) observée(s) — la plus récente est la version actuelle`">
      <ol class="space-y-2 text-sm">
        <li v-for="(v, i) in list" :key="v.id" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
          <span class="w-40 shrink-0 text-xs text-slate-500">{{ fmtDate(v.observedAt) }}</span>
          <span class="font-mono">{{ v.image.startsWith("sha256:") ? `image locale ${short(v.image)}` : v.image }}</span>
          <span class="font-mono text-xs text-slate-500" :title="v.digest ?? v.imageId">{{ v.digest ? v.digest.slice(0, 19) : `id ${short(v.imageId)}` }}</span>
          <span v-if="i === 0" class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">actuelle</span>
        </li>
      </ol>
    </PanelCard>
  </div>
</template>
