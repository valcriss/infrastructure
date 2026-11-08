<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api, fmtDate, type OperationView, type StackDetail } from "../../api";
import OperationLog from "../../components/OperationLog.vue";

const props = defineProps<{ stack: StackDetail }>();
const operations = ref<Omit<OperationView, "log">[]>([]);
// ?operation=<id> présélectionne une opération (lien depuis la liste des applications ou le tableau de bord).
const selected = ref(String(useRoute().query.operation ?? ""));
let timer: number | undefined;

const labels: Record<string, string> = { pending: "en attente", running: "en cours", succeeded: "réussie", failed: "échouée", unknown: "résultat inconnu" };
const types: Record<string, string> = { deploy: "Déploiement", stop: "Arrêt", start: "Démarrage", destroy: "Suppression" };

async function load() {
  operations.value = (await api<{ operations: OperationView[] }>(`/api/v1/operations?stackId=${props.stack.id}&limit=30`)).operations;
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[24rem_1fr]">
    <section class="rounded-lg border border-slate-200 bg-white">
      <h2 class="border-b border-slate-200 px-4 py-2 font-semibold">Opérations récentes</h2>
      <p v-if="operations.length === 0" class="px-4 py-3 text-sm text-slate-500">Aucune opération.</p>
      <ul class="divide-y divide-slate-100 text-sm">
        <li v-for="o in operations" :key="o.id">
          <button class="w-full px-4 py-2 text-left hover:bg-slate-50" :class="{ 'bg-slate-100': selected === o.id }" @click="selected = o.id">
            {{ types[o.type] }}<span v-if="o.revision"> r{{ o.revision }}</span> — {{ labels[o.status] }}
            <span class="block text-xs text-slate-400">{{ fmtDate(o.createdAt) }} · {{ o.requestedBy }}</span>
          </button>
        </li>
      </ul>
    </section>
    <section>
      <OperationLog v-if="selected" :key="selected" :operation-id="selected" />
      <p v-else class="text-sm text-slate-500">Sélectionnez une opération pour voir son journal. Les valeurs sensibles y sont masquées.</p>
    </section>
  </div>
</template>
