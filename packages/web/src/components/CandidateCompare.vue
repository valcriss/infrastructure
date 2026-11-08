<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, describeError, type CandidateView, type TagSuggestions } from "../api";
import { useSession } from "../stores/session";
import SeverityBadges from "./SeverityBadges.vue";

// Compare les vulnérabilités d'une autre version de l'image avant de l'adopter : l'image est téléchargée sur
// l'hôte, scannée puis retirée. Rien n'est déployé.
const props = defineProps<{ stackId: string; service: string }>();
const session = useSession();

const suggestions = ref<TagSuggestions | null>(null);
const candidates = ref<CandidateView[]>([]);
const tag = ref("");
const error = ref("");
const busy = ref(false);
let timer: number | undefined;

const mine = computed(() => candidates.value.filter((c) => c.service === props.service));
const running = computed(() => mine.value.some((c) => c.status === "pulling" || c.status === "scanning"));

async function load() {
  try {
    candidates.value = (await api<{ candidates: CandidateView[] }>(`/api/v1/stacks/${props.stackId}/candidate-scans`)).candidates;
  } catch {
    /* réessayé au prochain passage */
  }
}

onMounted(async () => {
  void load();
  timer = window.setInterval(() => void load(), 4000);
  try {
    suggestions.value = await api<TagSuggestions>(`/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/tag-suggestions`);
  } catch (err) {
    error.value = describeError(err);
  }
});
onBeforeUnmount(() => window.clearInterval(timer));

async function compare(t: string) {
  const value = t.trim();
  if (!value) return;
  error.value = "";
  busy.value = true;
  try {
    await api(`/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/candidate-scans`, { method: "POST", body: JSON.stringify({ tag: value }) });
    tag.value = "";
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const severe = (c: { critical: number; high: number }): number => c.critical + c.high;
const STATUS: Record<CandidateView["status"], string> = { pulling: "téléchargement…", scanning: "scan en cours…", succeeded: "terminé", failed: "échec" };

/** Verdict lisible : mieux, pareil ou pire sur les CVE critiques et élevées. */
function verdict(c: CandidateView): { text: string; cls: string } | null {
  if (!c.result || !c.current) return null;
  const a = severe(c.current.counts);
  const b = severe(c.result.counts);
  if (b < a) return { text: `${a - b} CVE critique(s)/élevée(s) de moins (${a} → ${b})`, cls: "text-green-700" };
  if (b > a) return { text: `${b - a} CVE critique(s)/élevée(s) de plus (${a} → ${b})`, cls: "text-red-700" };
  return { text: `Autant de CVE critiques/élevées (${a})`, cls: "text-slate-600" };
}

const chips = computed(() => [
  ...(suggestions.value?.newer ?? []).map((t) => ({ tag: t, kind: "plus récente" })),
  ...(suggestions.value?.variants ?? []).map((t) => ({ tag: t, kind: "variante légère" })),
]);
</script>

<template>
  <section class="space-y-3 border-t border-slate-100 pt-3 text-sm" aria-label="Comparer une autre version">
    <h3 class="font-medium">Comparer une autre version</h3>
    <p class="text-xs text-slate-500">
      Télécharge l'image sur l'hôte, la scanne puis la retire : rien n'est déployé. Pour adopter une version, modifiez le tag dans Configuration → Compose, puis déployez.
    </p>
    <div v-if="chips.length" class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-slate-500">Suggestions :</span>
      <button v-for="c in chips" :key="c.tag" :disabled="!session.canOperate || busy" class="rounded-full border border-slate-300 px-2.5 py-0.5 font-mono text-xs hover:bg-slate-100 disabled:opacity-50" :title="c.kind" @click="compare(c.tag)">{{ c.tag }}</button>
    </div>
    <p v-if="suggestions?.note" class="text-xs text-slate-500">{{ suggestions.note }}</p>
    <form class="flex flex-wrap items-end gap-2" @submit.prevent="compare(tag)">
      <label class="text-xs">
        <span class="block font-medium">Étiquette à comparer</span>
        <input v-model="tag" :disabled="!session.canOperate" placeholder="ex. 5.130-alpine" class="mt-1 rounded border border-slate-300 px-2 py-1.5 font-mono text-sm" />
      </label>
      <button :disabled="!session.canOperate || busy || !tag.trim()" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50">Comparer</button>
      <span v-if="running" class="text-xs text-blue-700" aria-live="polite">Comparaison en cours…</span>
    </form>
    <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>

    <ul v-if="mine.length" class="space-y-2">
      <li v-for="c in mine" :key="c.id" class="rounded border border-slate-200 p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono text-xs font-semibold">{{ c.tag }}</span>
          <span class="text-xs" :class="c.status === 'failed' ? 'text-red-700' : 'text-slate-500'">{{ STATUS[c.status] }}</span>
        </div>
        <p v-if="c.error" class="mt-1 text-xs text-red-700">{{ c.error }}</p>
        <div v-if="c.result" class="mt-2 space-y-1 text-xs">
          <p class="flex flex-wrap items-center gap-2">
            <span class="w-20 text-slate-500">Cette version</span>
            <SeverityBadges :state="c.result.total ? 'vulnerable' : 'clean'" :counts="c.result.counts" />
            <span class="text-slate-500">dont {{ c.result.fixable }} avec correctif</span>
          </p>
          <p v-if="c.current" class="flex flex-wrap items-center gap-2">
            <span class="w-20 text-slate-500">Actuelle</span>
            <SeverityBadges :state="c.current.total ? 'vulnerable' : 'clean'" :counts="c.current.counts" />
            <span class="text-slate-500">dont {{ c.current.fixable }} avec correctif</span>
          </p>
          <p v-if="verdict(c)" class="font-medium" :class="verdict(c)!.cls">{{ verdict(c)!.text }}</p>
          <p v-if="c.result.os?.eosl" class="text-amber-700">Le système de cette image ({{ c.result.os.family }} {{ c.result.os.name }}) n'est plus maintenu.</p>
        </div>
      </li>
    </ul>
  </section>
</template>
