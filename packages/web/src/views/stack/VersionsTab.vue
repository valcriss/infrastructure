<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ago, api, describeError, fmtDate, shortId, type StackImageComponent, type UpdatePolicyName } from "../../api";
import PanelCard from "../../components/PanelCard.vue";
import { useSession } from "../../stores/session";

// Versions d'un projet observé : mises à jour disponibles (mêmes règles de suivi qu'une stack gérée, rien n'est
// déployé) et historique des changements d'image, un changement d'étiquette ou de contenu par ligne.
const props = defineProps<{ project: { hostId: string; name: string } }>();

interface Version { id: string; service: string; image: string; imageId: string; digest: string | null; observedAt: string }
type Component = Omit<StackImageComponent, "image">;

const session = useSession();
const base = computed(() => `/api/v1/hosts/${props.project.hostId}/projects/${encodeURIComponent(props.project.name)}`);

const versions = ref<Version[]>([]);
const components = ref<Component[]>([]);
const checking = ref(false);
const loaded = ref(false);
const error = ref("");
const info = ref("");
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
    const [v, u] = await Promise.all([
      api<{ versions: Version[] }>(`${base.value}/versions`),
      api<{ checking: boolean; components: Component[] }>(`${base.value}/updates`),
    ]);
    versions.value = v.versions;
    components.value = u.components;
    checking.value = u.checking;
    for (const c of u.components) draft[c.service] ??= { policy: c.policy.policy, pattern: c.policy.pattern ?? "" };
  } catch (err) {
    error.value = describeError(err);
  }
  loaded.value = true;
}

async function act(run: () => Promise<unknown>, message: string) {
  error.value = info.value = "";
  try {
    await run();
    info.value = message;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

const check = () => act(() => api(`${base.value}/image-checks`, { method: "POST" }), "Vérification lancée.");

function ignoreTag(service: string, tag: string) {
  const reason = window.prompt(`Ne plus proposer « ${tag} » pour « ${service} » ?\nMotif (facultatif, ex. incompatible avec les données) :`, "");
  if (reason === null) return;
  void act(
    () => api(`${base.value}/services/${encodeURIComponent(service)}/ignored-tags`, { method: "POST", body: JSON.stringify({ tag, ...(reason.trim() ? { reason: reason.trim() } : {}) }) }),
    `La version « ${tag} » n'est plus proposée pour « ${service} ».`,
  );
}

const unignoreTag = (service: string, tag: string) =>
  act(() => api(`${base.value}/services/${encodeURIComponent(service)}/ignored-tags/${encodeURIComponent(tag)}`, { method: "DELETE" }), `La version « ${tag} » sera de nouveau proposée (vérification relancée).`);

function savePolicy(service: string) {
  const d = draft[service];
  if (!d) return;
  void act(
    () => api(`${base.value}/services/${encodeURIComponent(service)}/update-policy`, { method: "PUT", body: JSON.stringify({ policy: d.policy, pattern: d.policy === "pattern" ? d.pattern : null }) }),
    `Règle de suivi de « ${service} » enregistrée.`,
  );
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));

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
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>

    <PanelCard title="Mises à jour" icon="arrow-up-right-from-square" subtitle="Comparaison avec le registre selon la règle de suivi de chaque service. Rien n'est téléchargé ni déployé.">
      <template #actions>
        <button v-if="session.canOperate" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50" :disabled="checking" @click="check">
          {{ checking ? "Vérification en cours…" : "Vérifier les mises à jour" }}
        </button>
      </template>
      <p v-if="loaded && components.length === 0" class="text-sm text-slate-500">Aucun service en cours d'exécution dans ce projet.</p>
      <div class="space-y-4">
        <section v-for="c in components" :key="c.service" class="space-y-2 border-t border-slate-100 pt-3 text-sm first:border-0 first:pt-0">
          <h3 class="flex flex-wrap items-baseline gap-2 font-medium">{{ c.service }} <span class="font-mono text-xs font-normal text-slate-500">{{ c.ref }}</span></h3>
          <p v-if="!c.check" class="text-slate-500">Aucune vérification pour cette image (jamais faite, ou l'image a changé depuis).</p>
          <template v-else>
            <p v-if="c.check.status === 'error'" role="alert" class="rounded bg-red-50 p-2 text-red-800">
              Vérification impossible : {{ c.check.error }}
              <template v-if="c.check.lastSuccessAt"> — dernière observation réussie {{ ago(c.check.lastSuccessAt) }} (conservée ci-dessous).</template>
            </p>
            <template v-if="c.check.detail">
              <p v-if="c.check.kind === 'up_to_date'" class="text-green-700">À jour : le tag « {{ c.check.detail.tag }} » pointe toujours vers le contenu en place.</p>
              <p v-else-if="c.check.kind === 'pinned'" class="text-slate-600">Image épinglée par digest.</p>
              <p v-else-if="c.check.kind === 'local'" class="text-slate-600">Image locale : aucune comparaison avec un registre.</p>
              <template v-else-if="c.check.kind === 'update_available'">
                <p v-if="c.check.detail.contentChanged" class="text-amber-700">Le tag « {{ c.check.detail.tag }} » pointe vers un nouveau contenu dans le registre.</p>
                <div v-if="c.check.detail.candidates.length">
                  <p class="text-amber-700">Versions plus récentes{{ c.check.detail.uncertain ? " (candidats incertains)" : "" }} :</p>
                  <ul class="mt-1 flex flex-wrap gap-2">
                    <li v-for="t in c.check.detail.candidates" :key="t" class="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-mono text-xs text-amber-900">
                      {{ t }}
                      <button v-if="session.canOperate" class="rounded px-1 font-sans text-[11px] underline hover:bg-amber-200" :title="`Ne plus proposer ${t}`" @click="ignoreTag(c.service, t)">ignorer</button>
                    </li>
                  </ul>
                </div>
              </template>
              <ul v-if="c.check.detail.notes.length" class="list-disc space-y-0.5 pl-5 text-xs text-slate-600"><li v-for="n in c.check.detail.notes" :key="n">{{ n }}</li></ul>
              <p class="text-xs text-slate-500">
                Vérifié {{ ago(c.check.checkedAt) }} · en place {{ c.check.detail.deployedDigest ? shortId(c.check.detail.deployedDigest) : "—" }}
                · registre {{ c.check.detail.remoteDigest ? shortId(c.check.detail.remoteDigest) : "—" }}
              </p>
            </template>
          </template>

          <div v-if="c.ignoredTags.length" class="text-xs text-slate-600">
            <p class="font-medium">Versions ignorées (plus proposées)</p>
            <ul class="mt-1 space-y-1">
              <li v-for="i in c.ignoredTags" :key="i.tag" class="flex flex-wrap items-center gap-2">
                <span class="rounded bg-slate-100 px-2 py-0.5 font-mono">{{ i.tag }}</span>
                <span v-if="i.reason">{{ i.reason }}</span>
                <span class="text-slate-400">par {{ i.createdBy }}, {{ ago(i.createdAt) }}</span>
                <button v-if="session.canOperate" class="underline" @click="unignoreTag(c.service, i.tag)">Proposer de nouveau</button>
              </li>
            </ul>
          </div>

          <form v-if="session.canOperate && draft[c.service]" class="flex flex-wrap items-end gap-2" @submit.prevent="savePolicy(c.service)">
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
      </div>
    </PanelCard>

    <p v-if="loaded && groups.length === 0" class="text-sm text-slate-500">Aucune version enregistrée pour le moment : l'historique commence à la première observation du projet.</p>
    <PanelCard v-for="[service, list] in groups" :key="service" :title="`Historique — ${service}`" icon="code-branch" :subtitle="`${list.length} version(s) observée(s) — la plus récente est la version actuelle`">
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
