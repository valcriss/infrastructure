<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, describeError, type RevisionDetail, type VariableView } from "../api";
import DiffView from "./DiffView.vue";

// Différences entre deux révisions d'une stack : Compose, variables (valeurs sensibles masquées) et fichiers.
// `from` absent : tout est ajouté (premier déploiement).
const props = defineProps<{ stackId: string; from: number | null; to: number }>();

const before = ref<RevisionDetail | null>(null);
const after = ref<RevisionDetail | null>(null);
const error = ref("");
const loading = ref(true);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const get = (n: number) => api<RevisionDetail>(`/api/v1/stacks/${props.stackId}/revisions/${n}`);
    [after.value, before.value] = await Promise.all([get(props.to), props.from === null ? Promise.resolve(null) : get(props.from)]);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => [props.from, props.to], load);

const varLines = (vars: VariableView[] | undefined): string => (vars ?? []).map((v) => `${v.name}=${v.sensitive ? "•••••• (sensible)" : v.value}`).join("\n");
const changedFiles = computed(() => {
  const a = after.value?.files ?? {};
  const b = before.value?.files ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((n) => (a[n] ?? null) !== (b[n] ?? null));
});
const composeChanged = computed(() => (before.value?.compose ?? "") !== (after.value?.compose ?? ""));
const varsChanged = computed(() => varLines(before.value?.variables) !== varLines(after.value?.variables));
const nothing = computed(() => !composeChanged.value && !varsChanged.value && changedFiles.value.length === 0);
</script>

<template>
  <div class="space-y-3 text-sm">
    <p v-if="loading" class="text-slate-500">Chargement des différences…</p>
    <p v-else-if="error" role="alert" class="text-red-700">{{ error }}</p>
    <template v-else>
      <p class="text-xs text-slate-500">Révision {{ from ?? "∅" }} → révision {{ to }}</p>
      <p v-if="nothing" class="text-slate-600">Aucune différence de configuration entre ces deux révisions.</p>
      <div v-if="composeChanged"><h3 class="mb-1 font-medium">Compose</h3><DiffView :before="before?.compose ?? ''" :after="after?.compose ?? ''" /></div>
      <div v-if="varsChanged"><h3 class="mb-1 font-medium">Variables</h3><DiffView :before="varLines(before?.variables)" :after="varLines(after?.variables)" /></div>
      <div v-for="f in changedFiles" :key="f"><h3 class="mb-1 font-mono text-xs font-medium">{{ f }}</h3><DiffView :before="before?.files[f] ?? ''" :after="after?.files[f] ?? ''" /></div>
    </template>
  </div>
</template>
