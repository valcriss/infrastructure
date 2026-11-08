<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, describeError, fmtDate, type RevisionDetail, type RevisionSummary, type StackDetail, type VariableView } from "../../api";
import DeployDialog from "../../components/DeployDialog.vue";
import DiffView from "../../components/DiffView.vue";
import OperationLog from "../../components/OperationLog.vue";
import { useSession } from "../../stores/session";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

const session = useSession();
const revisions = ref<RevisionSummary[]>([]);
const selected = ref<RevisionDetail | null>(null);
const previous = ref<RevisionDetail | null>(null);
const operationId = ref("");
const error = ref("");
const info = ref("");
const abandoning = ref(false);
const reason = ref("");
const busy = ref(false);

async function load() {
  revisions.value = (await api<{ revisions: RevisionSummary[] }>(`/api/v1/stacks/${props.stack.id}/revisions`)).revisions;
}

async function select(n: number) {
  error.value = "";
  const get = (r: number) => api<RevisionDetail>(`/api/v1/stacks/${props.stack.id}/revisions/${r}`);
  selected.value = await get(n);
  previous.value = n > 1 ? await get(n - 1) : null;
}

const varLines = (vars: VariableView[] | undefined): string =>
  (vars ?? []).map((v) => `${v.name}=${v.sensitive ? "•••••• (sensible)" : v.value}`).join("\n");
const fileNames = (r: RevisionDetail | null) => Object.keys(r?.files ?? {}).sort();

const changedFiles = computed(() => {
  const names = new Set([...fileNames(selected.value), ...fileNames(previous.value)]);
  return [...names].sort().filter((n) => (selected.value?.files[n] ?? null) !== (previous.value?.files[n] ?? null));
});

const deployTarget = ref<number | null>(null);
function onStarted(id: string) {
  deployTarget.value = null;
  operationId.value = id;
}

watch(() => props.stack.currentRevision, () => void load());

/** Une révision en service ne peut pas être abandonnée ; une révision déjà abandonnée se rétablit. */
const canAbandon = computed(() => !!selected.value && !selected.value.abandoned && selected.value.revision !== props.stack.deployedRevision && session.canOperate);
/** Abandonner la révision courante crée une révision qui repart de celle en service (ou, à défaut, de la dernière saine). */
const restoreBase = computed(() => (selected.value?.revision === props.stack.currentRevision ? (props.stack.deployedRevision ?? "la dernière révision saine") : null));

async function abandon() {
  if (!selected.value) return;
  error.value = info.value = "";
  busy.value = true;
  const n = selected.value.revision;
  try {
    const r = await api<{ abandoned: number; revision: number | null; restoredFrom: number | null }>(`/api/v1/stacks/${props.stack.id}/revisions/${n}/abandon`, {
      method: "POST",
      body: JSON.stringify(reason.value.trim() ? { reason: reason.value.trim() } : {}),
    });
    info.value = r.revision
      ? `Révision ${n} abandonnée. La révision ${r.revision} reprend le contenu de la révision ${r.restoredFrom} : les prochaines modifications partent de là.`
      : `Révision ${n} abandonnée : elle n'est plus proposée au déploiement.`;
    abandoning.value = false;
    reason.value = "";
    await load();
    emit("changed");
    await select(r.revision ?? n);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function restore() {
  if (!selected.value) return;
  error.value = info.value = "";
  const n = selected.value.revision;
  try {
    await api(`/api/v1/stacks/${props.stack.id}/revisions/${n}/restore`, { method: "POST" });
    info.value = `Révision ${n} rétablie : elle peut de nouveau être déployée.`;
    await load();
    emit("changed");
    await select(n);
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(load);
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[22rem_1fr]">
    <section class="rounded-lg border border-slate-200 bg-white">
      <h2 class="border-b border-slate-200 px-4 py-2 font-semibold">Révisions</h2>
      <ul class="max-h-[32rem] divide-y divide-slate-100 overflow-auto text-sm">
        <li v-for="r in revisions" :key="r.revision">
          <button class="w-full px-4 py-2 text-left hover:bg-slate-50" :class="{ 'bg-slate-100': selected?.revision === r.revision, 'opacity-60': r.abandoned }" @click="select(r.revision)">
            <span class="font-medium" :class="{ 'line-through': r.abandoned }">r{{ r.revision }}</span>
            <span v-if="r.abandoned" class="ml-1 rounded bg-slate-200 px-1.5 text-xs text-slate-700" :title="r.abandoned.reason ?? 'Abandonnée'">abandonnée</span>
            <span v-if="r.revision === stack.currentRevision" class="ml-1 rounded bg-slate-200 px-1.5 text-xs">courante</span>
            <span v-if="r.revision === stack.deployedRevision" class="ml-1 rounded bg-green-100 px-1.5 text-xs text-green-800">déployée</span>
            <span class="block text-xs text-slate-500">{{ r.message ?? "—" }}</span>
            <span class="block text-xs text-slate-400">{{ fmtDate(r.createdAt) }} · {{ r.author }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section class="space-y-4">
      <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
      <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
      <template v-if="selected">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-semibold">Révision {{ selected.revision }} — différences avec {{ previous ? "r" + previous.revision : "le début" }}</h2>
          <div class="flex flex-wrap gap-2">
            <button v-if="canAbandon" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100" @click="abandoning = !abandoning">Abandonner cette révision…</button>
            <button v-if="selected.abandoned && session.canOperate" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100" @click="restore">Rétablir</button>
            <button :disabled="stack.hostPresence === 'offline' || !!selected.abandoned" :title="selected.abandoned ? 'Révision abandonnée : rétablissez-la avant' : ''" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50" @click="deployTarget = selected.revision">
              Déployer cette révision
            </button>
          </div>
        </div>
        <p v-if="selected.abandoned" class="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
          Révision abandonnée le {{ fmtDate(selected.abandoned.at) }}<template v-if="selected.abandoned.reason"> : {{ selected.abandoned.reason }}</template>. Elle reste dans l'historique mais n'est plus proposée au déploiement.
        </p>
        <form v-if="abandoning && canAbandon" class="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" @submit.prevent="abandon">
          <p>
            La révision {{ selected.revision }} reste dans l'historique mais ne sera plus proposée.
            <template v-if="restoreBase !== null">Une nouvelle révision reprendra le contenu de {{ typeof restoreBase === "number" ? `la révision ${restoreBase} (en service)` : restoreBase }} : rien n'est déployé, les conteneurs ne changent pas.</template>
          </p>
          <input v-model="reason" maxlength="200" placeholder="Motif (facultatif, ex. MySQL 8.4 incompatible avec les données)" aria-label="Motif" class="w-full rounded border border-amber-300 bg-white px-3 py-2 text-slate-900" />
          <div class="flex gap-2">
            <button :disabled="busy" class="rounded bg-amber-600 px-3 py-1.5 text-white hover:bg-amber-700 disabled:opacity-50">Abandonner la révision {{ selected.revision }}</button>
            <button type="button" class="rounded border border-amber-400 bg-white px-3 py-1.5 text-slate-900" @click="abandoning = false">Annuler</button>
          </div>
        </form>
        <div>
          <h3 class="mb-1 text-sm font-medium">Compose</h3>
          <DiffView :before="previous?.compose ?? ''" :after="selected.compose" />
        </div>
        <div>
          <h3 class="mb-1 text-sm font-medium">Variables</h3>
          <DiffView :before="varLines(previous?.variables)" :after="varLines(selected.variables)" />
        </div>
        <div v-for="f in changedFiles" :key="f">
          <h3 class="mb-1 font-mono text-xs font-medium">{{ f }}</h3>
          <DiffView :before="previous?.files[f] ?? ''" :after="selected.files[f] ?? ''" />
        </div>
      </template>
      <p v-else class="text-sm text-slate-500">Sélectionnez une révision pour voir ce qu'elle a changé.</p>
      <DeployDialog v-if="deployTarget !== null" :stack="stack" :target="deployTarget" @close="deployTarget = null" @started="onStarted" />
      <OperationLog v-if="operationId" :operation-id="operationId" :stack-id="stack.id" @finished="emit('changed')" />
    </section>
  </div>
</template>
