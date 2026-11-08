<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api, describeError } from "../../api";
import PanelCard from "../../components/PanelCard.vue";
import { useSession } from "../../stores/session";

// Affichage : faut-il montrer les éléments de la console elle-même (ses conteneurs et ses images) dans les vues ?
interface Display { showConsole: boolean; selfProjects: string[] }

const session = useSession();
const form = reactive<Display>({ showConsole: true, selfProjects: [] });
const error = ref("");
const ok = ref("");
const loaded = ref(false);

onMounted(async () => {
  try {
    Object.assign(form, await api<Display>("/api/v1/settings/display"));
    loaded.value = true;
  } catch (err) {
    error.value = describeError(err);
  }
});

async function save() {
  error.value = ok.value = "";
  try {
    Object.assign(form, await api<Display>("/api/v1/settings/display", { method: "PUT", body: JSON.stringify({ showConsole: form.showConsole }) }));
    ok.value = form.showConsole ? "Les éléments de la console sont affichés." : "Les éléments de la console sont masqués.";
  } catch (err) {
    error.value = describeError(err);
  }
}
</script>

<template>
  <PanelCard title="Affichage" icon="eye" subtitle="Éléments de la console elle-même (son projet Compose et celui de son agent)">
    <label class="flex items-start gap-3 text-sm">
      <input v-model="form.showConsole" type="checkbox" class="mt-1" :disabled="!loaded || !session.isAdmin" @change="save" />
      <span>
        <span class="font-medium">Afficher les éléments de la console dans les tableaux de bord, applications, images et métriques</span>
        <span class="mt-1 block text-xs text-slate-500">
          Décoché, ses conteneurs, ses images, ses alertes et sa consommation n'apparaissent plus dans les vues ni dans les compteurs.
          Ils restent surveillés et scannés en arrière-plan, et réapparaissent dès que la case est cochée. La page Hôtes montre toujours tous les conteneurs de la machine.
        </span>
      </span>
    </label>
    <p v-if="!session.isAdmin" class="mt-3 text-xs text-slate-500">Seul un administrateur peut modifier ce réglage.</p>
    <p v-if="form.selfProjects.length" class="mt-3 text-xs text-slate-500">
      Projets Compose concernés : <code>{{ form.selfProjects.join(", ") }}</code>. Si la console est déployée sous un autre nom de projet, ajoutez-le à la variable <code>SELF_PROJECTS</code> de la console.
    </p>
    <p v-if="ok" role="status" class="mt-2 text-sm text-green-700">{{ ok }}</p>
    <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
  </PanelCard>
</template>
