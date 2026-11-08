<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, fmtDate, type RevisionDetail, type RevisionSummary, type StackDetail, type VariableView } from "../../api";
import DeployDialog from "../../components/DeployDialog.vue";
import DiffView from "../../components/DiffView.vue";
import OperationLog from "../../components/OperationLog.vue";

const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

const revisions = ref<RevisionSummary[]>([]);
const selected = ref<RevisionDetail | null>(null);
const previous = ref<RevisionDetail | null>(null);
const operationId = ref("");
const error = ref("");

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

onMounted(load);
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[22rem_1fr]">
    <section class="rounded-lg border border-slate-200 bg-white">
      <h2 class="border-b border-slate-200 px-4 py-2 font-semibold">Révisions</h2>
      <ul class="max-h-[32rem] divide-y divide-slate-100 overflow-auto text-sm">
        <li v-for="r in revisions" :key="r.revision">
          <button class="w-full px-4 py-2 text-left hover:bg-slate-50" :class="{ 'bg-slate-100': selected?.revision === r.revision }" @click="select(r.revision)">
            <span class="font-medium">r{{ r.revision }}</span>
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
      <template v-if="selected">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-semibold">Révision {{ selected.revision }} — différences avec {{ previous ? "r" + previous.revision : "le début" }}</h2>
          <button :disabled="stack.hostPresence === 'offline'" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50" @click="deployTarget = selected.revision">
            Déployer cette révision
          </button>
        </div>
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
