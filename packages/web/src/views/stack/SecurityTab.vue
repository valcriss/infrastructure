<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ago, api, describeError, fmtDate, shortId, type StackDetail, type StackImageComponent, type UpdatePolicyName } from "../../api";
import ScanBadge from "../../components/ScanBadge.vue";
import VulnerabilityTable from "../../components/VulnerabilityTable.vue";

const props = defineProps<{ stack: StackDetail }>();

const components = ref<StackImageComponent[]>([]);
const checking = ref(false);
const error = ref("");
const info = ref("");
const open = reactive<Record<string, boolean>>({});
const draft = reactive<Record<string, { policy: UpdatePolicyName; pattern: string }>>({});
let timer: number | undefined;

const policies: { key: UpdatePolicyName; label: string; help: string }[] = [
  { key: "same_tag", label: "Même tag uniquement", help: "Détecte seulement un nouveau contenu derrière le tag actuel." },
  { key: "patch", label: "Correctifs (1.2.x)", help: "Propose les versions plus récentes de même mineure." },
  { key: "minor", label: "Mineures (1.x)", help: "Propose les versions plus récentes de même majeure." },
  { key: "major", label: "Majeures", help: "Propose toute version plus récente." },
  { key: "pattern", label: "Expression libre", help: "Tags correspondant à une expression régulière (sans groupe répété)." },
];

async function load() {
  try {
    const r = await api<{ checking: boolean; components: StackImageComponent[] }>(`/api/v1/stacks/${props.stack.id}/images`);
    components.value = r.components;
    checking.value = r.checking;
    for (const c of r.components) draft[c.service] ??= { policy: c.policy.policy, pattern: c.policy.pattern ?? "" };
    error.value = "";
  } catch (err) {
    error.value = describeError(err);
  }
}

const busy = computed(() => checking.value || components.value.some((c) => ["pending", "running"].includes(c.image.scan.state)));

async function act(path: string, message: string) {
  error.value = info.value = "";
  try {
    await api(`/api/v1/stacks/${props.stack.id}/${path}`, { method: "POST" });
    info.value = message;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function savePolicy(service: string) {
  error.value = info.value = "";
  const d = draft[service];
  if (!d) return;
  try {
    await api(`/api/v1/stacks/${props.stack.id}/services/${encodeURIComponent(service)}/update-policy`, {
      method: "PUT",
      body: JSON.stringify({ policy: d.policy, pattern: d.policy === "pattern" ? d.pattern : null }),
    });
    info.value = `Règle de suivi de « ${service} » enregistrée (sauvegardée dans Git avec la stack).`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 4000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <button :disabled="stack.hostPresence === 'offline'" class="rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:opacity-50" @click="act('scans', 'Scans demandés.')">Scanner les images</button>
      <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="act('image-checks', 'Vérification lancée.')">Vérifier les mises à jour</button>
      <span v-if="busy" class="text-xs text-blue-700" aria-live="polite">Traitement en cours…</span>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <p v-if="stack.hostPresence === 'offline'" class="rounded bg-amber-50 p-3 text-sm text-amber-800">Agent hors ligne : les scans sont impossibles. Les résultats affichés sont les derniers connus, datés.</p>
    <p v-if="components.length === 0" class="text-sm text-slate-500">Aucune image observée : la stack n'est pas déployée ou l'hôte n'a pas encore remonté d'inventaire.</p>

    <article v-for="c in components" :key="c.service" class="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <header class="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 class="font-semibold">{{ c.service }}</h2>
          <p class="font-mono text-xs text-slate-600">{{ c.ref }}</p>
          <p class="text-xs text-slate-400">{{ c.image.platform || "plateforme inconnue" }} · {{ shortId(c.image.imageId) }}</p>
        </div>
        <div><ScanBadge :scan="c.image.scan" /></div>
      </header>

      <div v-if="c.image.scan.current?.total" class="text-sm">
        <button class="underline" :aria-expanded="!!open[c.service]" @click="open[c.service] = !open[c.service]">
          {{ open[c.service] ? "Masquer" : "Voir" }} les vulnérabilités
        </button>
        <div v-if="open[c.service]" class="mt-3"><VulnerabilityTable :image-id="c.image.imageId" :platform="c.image.platform" /></div>
      </div>

      <section class="space-y-2 border-t border-slate-100 pt-3 text-sm" aria-label="Versions disponibles">
        <h3 class="font-medium">Mises à jour de l'image</h3>
        <p v-if="!c.check" class="text-slate-500">Jamais vérifiée. Les registres ne sont interrogés qu'à la demande ou selon la planification.</p>
        <template v-else>
          <p v-if="c.check.status === 'error'" role="alert" class="rounded bg-red-50 p-2 text-red-800">
            Vérification impossible : {{ c.check.error }}
            <template v-if="c.check.lastSuccessAt"> — dernière observation réussie {{ ago(c.check.lastSuccessAt) }} (conservée ci-dessous).</template>
            <template v-else> — aucune observation réussie pour l'instant : l'état est inconnu.</template>
          </p>
          <template v-if="c.check.detail">
            <p v-if="c.check.kind === 'up_to_date'" class="text-green-700">À jour : le tag « {{ c.check.detail.tag }} » pointe toujours vers le contenu déployé.</p>
            <p v-else-if="c.check.kind === 'pinned'" class="text-slate-600">Image épinglée par digest.</p>
            <p v-else-if="c.check.kind === 'local'" class="text-slate-600">Image locale : aucune comparaison avec un registre.</p>
            <template v-else-if="c.check.kind === 'update_available'">
              <p v-if="c.check.detail.contentChanged" class="text-amber-700">Le tag « {{ c.check.detail.tag }} » pointe vers un nouveau contenu dans le registre.</p>
              <div v-if="c.check.detail.candidates.length">
                <p class="text-amber-700">Versions plus récentes{{ c.check.detail.uncertain ? " (candidats incertains)" : "" }} :</p>
                <ul class="mt-1 flex flex-wrap gap-2"><li v-for="t in c.check.detail.candidates" :key="t" class="rounded bg-amber-100 px-2 py-0.5 font-mono text-xs text-amber-900">{{ t }}</li></ul>
              </div>
              <p class="text-xs text-slate-500">Rien n'est déployé automatiquement : modifiez le tag dans le Compose (onglet Compose) puis déployez.</p>
            </template>
            <ul v-if="c.check.detail.notes.length" class="list-disc space-y-0.5 pl-5 text-xs text-slate-600"><li v-for="n in c.check.detail.notes" :key="n">{{ n }}</li></ul>
            <p class="text-xs text-slate-400">
              Vérifié {{ ago(c.check.checkedAt) }} · déployé {{ c.check.detail.deployedDigest ? shortId(c.check.detail.deployedDigest) : "—" }}
              · registre {{ c.check.detail.remoteDigest ? shortId(c.check.detail.remoteDigest) : "—" }}
            </p>
          </template>
        </template>

        <form class="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3" @submit.prevent="savePolicy(c.service)">
          <label class="text-xs">
            <span class="block font-medium">Règle de suivi</span>
            <select v-model="draft[c.service]!.policy" class="mt-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm" :aria-label="`Règle de suivi de ${c.service}`">
              <option v-for="p in policies" :key="p.key" :value="p.key" :title="p.help">{{ p.label }}</option>
            </select>
          </label>
          <label v-if="draft[c.service]?.policy === 'pattern'" class="text-xs">
            <span class="block font-medium">Expression</span>
            <input v-model="draft[c.service]!.pattern" placeholder="^v\d+\.\d+$" class="mt-1 rounded border border-slate-300 px-2 py-1.5 font-mono text-sm" />
          </label>
          <button class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">Enregistrer la règle</button>
          <span class="text-xs text-slate-400">{{ policies.find((p) => p.key === draft[c.service]?.policy)?.help }}</span>
        </form>
      </section>
      <p class="text-[11px] text-slate-400">Dernière tentative : {{ c.image.scan.lastAttempt ? fmtDate(c.image.scan.lastAttempt.finishedAt ?? c.image.scan.lastAttempt.createdAt) : "aucune" }}</p>
    </article>
  </div>
</template>
