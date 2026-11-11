<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import CopyButton from "../../components/CopyButton.vue";
import ToolsMenu, { type ToolItem } from "../../components/ToolsMenu.vue";
import TrackingRuleDialog from "../../components/TrackingRuleDialog.vue";
import UpdateBadge from "../../components/UpdateBadge.vue";
import { ago, api, describeError, fmtDate, shortId, type StackImageComponent, type UpdatePolicyName } from "../../api";
import PanelCard from "../../components/PanelCard.vue";
import { useSession } from "../../stores/session";

// Versions d'un projet observé : mises à jour disponibles (mêmes règles de suivi qu'une stack gérée, rien n'est
// déployé) et historique des changements d'image, un changement d'étiquette ou de contenu par ligne.
const props = defineProps<{ project: { hostId: string; name: string }; compose?: { dir?: string | undefined; files?: string | undefined } }>();

const sh = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** Commande à lancer sur l'hôte pour mettre à jour un service (la console ne déploie pas les projets observés). */
function updateCommand(service: string): string {
  const files = (props.compose?.files ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  const base = ["docker", "compose", "-p", sh(props.project.name), ...files.flatMap((f) => ["-f", sh(f)])].join(" ");
  const cd = !files.length && props.compose?.dir ? `cd ${sh(props.compose.dir)} && ` : "";
  return `${cd}${base} pull ${sh(service)} && ${base} up -d --no-deps ${sh(service)}`;
}

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
let timer: number | undefined;

const POLICY_LABELS: Record<UpdatePolicyName, string> = { same_tag: "même tag uniquement", patch: "correctifs", minor: "mineures", major: "majeures", pattern: "expression libre" };
const ruleTarget = ref<string | null>(null);
const ruleComponent = computed(() => components.value.find((c) => c.service === ruleTarget.value) ?? null);
const menuItems: ToolItem[] = [{ id: "rule", label: "Règle de suivi…", description: "Choisir quelles versions plus récentes proposer ; gérer les versions ignorées." }];

async function load() {
  try {
    const [v, u] = await Promise.all([
      api<{ versions: Version[] }>(`${base.value}/versions`),
      api<{ checking: boolean; components: Component[] }>(`${base.value}/updates`),
    ]);
    versions.value = v.versions;
    components.value = u.components;
    checking.value = u.checking;
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
        <section v-for="c in components" :key="c.service" class="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="flex items-start gap-2">
              <ToolsMenu v-if="session.canOperate" compact :label="`Actions de ${c.service}`" :items="menuItems" @select="ruleTarget = c.service" />
              <h3 class="flex flex-wrap items-baseline gap-2 font-medium">{{ c.service }} <span class="font-mono text-xs font-normal text-slate-500">{{ c.ref }}</span></h3>
            </div>
            <UpdateBadge :check="c.check" />
          </div>
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
                <div v-if="c.check.detail.contentChanged" class="space-y-1">
                  <p class="text-amber-700">Le tag « {{ c.check.detail.tag }} » pointe vers un nouveau contenu dans le registre.</p>
                  <p class="text-xs text-slate-500">La console ne déploie pas ce projet. Pour mettre à jour ce service, lancez sur l'hôte (le conteneur est recréé, brève interruption) :</p>
                  <p class="flex items-start gap-1"><code class="block flex-1 break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">{{ updateCommand(c.service) }}</code><CopyButton :text="updateCommand(c.service)" :label="`Copier la commande de mise à jour de ${c.service}`" /></p>
                </div>
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

          <p class="text-xs text-slate-500">
            Règle de suivi : {{ POLICY_LABELS[c.policy.policy] }}<template v-if="c.policy.policy === 'pattern' && c.policy.pattern"> (<code class="font-mono">{{ c.policy.pattern }}</code>)</template>
            <template v-if="c.ignoredTags.length"> · {{ c.ignoredTags.length }} version(s) ignorée(s)</template>
            <template v-if="session.canOperate"> — modifiable depuis le menu « … ».</template>
          </p>
        </section>
      </div>
    </PanelCard>
    <TrackingRuleDialog
      v-if="ruleComponent"
      :key="ruleComponent.service"
      :service="ruleComponent.service"
      :service-path="`${base}/services/${encodeURIComponent(ruleComponent.service)}`"
      :policy="ruleComponent.policy.policy"
      :pattern="ruleComponent.policy.pattern"
      :ignored-tags="ruleComponent.ignoredTags"
      :can-operate="session.canOperate"
      @close="ruleTarget = null"
      @changed="load"
    />

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
