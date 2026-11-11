<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ago, api, describeError, type StackImageComponent, type UpdatePolicyName } from "../api";

// Règle de suivi d'un service (quelles versions plus récentes proposer) et versions ignorées. Chaque changement est
// enregistré aussitôt : pas de bouton « Enregistrer ». Sert aux stacks gérées comme aux projets observés.
const props = defineProps<{
  /** Chemin d'API du service, sans suffixe : `/api/v1/stacks/<id>/services/<service>`. */
  servicePath: string;
  service: string;
  policy: UpdatePolicyName;
  pattern: string | null;
  ignoredTags: StackImageComponent["ignoredTags"];
  canOperate: boolean;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();

const policies: { key: UpdatePolicyName; label: string; help: string }[] = [
  { key: "same_tag", label: "Même tag uniquement", help: "Détecte seulement un nouveau contenu derrière le tag actuel." },
  { key: "patch", label: "Correctifs (1.2.x)", help: "Propose les versions plus récentes de même mineure." },
  { key: "minor", label: "Mineures (1.x)", help: "Propose les versions plus récentes de même majeure." },
  { key: "major", label: "Majeures", help: "Propose toute version plus récente." },
  { key: "pattern", label: "Expression libre", help: "Tags correspondant à une expression régulière (sans groupe répété)." },
];

const policy = ref<UpdatePolicyName>(props.policy);
const pattern = ref(props.pattern ?? "");
const saved = ref<{ policy: UpdatePolicyName; pattern: string }>({ policy: props.policy, pattern: props.pattern ?? "" });
const ignored = ref([...props.ignoredTags]);
const status = ref("");
const error = ref("");
const busy = ref(false);

function patternError(): string {
  if (!pattern.value.trim()) return "Saisissez une expression.";
  try {
    new RegExp(pattern.value);
    return "";
  } catch {
    return "Expression régulière invalide.";
  }
}

async function save() {
  status.value = "";
  if (policy.value === "pattern") {
    error.value = patternError();
    if (error.value) return;
  } else error.value = "";
  const next = { policy: policy.value, pattern: policy.value === "pattern" ? pattern.value : "" };
  if (next.policy === saved.value.policy && next.pattern === saved.value.pattern) return;
  busy.value = true;
  try {
    await api(`${props.servicePath}/update-policy`, { method: "PUT", body: JSON.stringify({ policy: next.policy, pattern: next.policy === "pattern" ? next.pattern : null }) });
    saved.value = next;
    status.value = "Enregistré.";
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
    policy.value = saved.value.policy;
    pattern.value = saved.value.pattern;
  } finally {
    busy.value = false;
  }
}

async function unignore(tag: string) {
  error.value = status.value = "";
  try {
    await api(`${props.servicePath}/ignored-tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
    ignored.value = ignored.value.filter((i) => i.tag !== tag);
    status.value = `« ${tag} » sera de nouveau proposée.`;
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`Règle de suivi de ${service}`" class="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-6 text-sm shadow-2xl">
      <h2 class="text-lg font-semibold">Règle de suivi — {{ service }}</h2>
      <p class="text-slate-600">Détermine quelles versions plus récentes sont proposées. Les changements sont enregistrés immédiatement.</p>

      <div class="space-y-3">
        <label class="block text-xs">
          <span class="block font-medium">Règle de suivi</span>
          <select v-model="policy" :disabled="!canOperate || busy" class="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm" @change="save">
            <option v-for="p in policies" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
        </label>
        <p class="text-xs text-slate-500">{{ policies.find((p) => p.key === policy)?.help }}</p>
        <label v-if="policy === 'pattern'" class="block text-xs">
          <span class="block font-medium">Expression</span>
          <input v-model="pattern" :disabled="!canOperate || busy" placeholder="^v\d+\.\d+$" class="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-sm" @blur="save" @keydown.enter.prevent="save" />
        </label>
      </div>
      <p v-if="error" role="alert" class="text-red-700">{{ error }}</p>
      <p v-else-if="status" role="status" class="text-green-700">{{ status }}</p>

      <div v-if="ignored.length" class="space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
        <p class="font-medium">Versions ignorées (plus proposées)</p>
        <ul class="space-y-1">
          <li v-for="i in ignored" :key="i.tag" class="flex flex-wrap items-center gap-2">
            <span class="rounded bg-slate-100 px-2 py-0.5 font-mono">{{ i.tag }}</span>
            <span v-if="i.reason">{{ i.reason }}</span>
            <span class="text-slate-400">par {{ i.createdBy }}, {{ ago(i.createdAt) }}</span>
            <button v-if="canOperate" class="underline" @click="unignore(i.tag)">Proposer de nouveau</button>
          </li>
        </ul>
      </div>

      <div class="flex justify-end">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">Fermer</button>
      </div>
    </div>
  </div>
</template>
