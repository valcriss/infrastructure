<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api, describeError } from "../../api";
import PanelCard from "../../components/PanelCard.vue";
import { GUIDE_HIDDEN_KEY, readJson, writeJson } from "../../persist";
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

// Aide de la page Images : préférence propre à ce navigateur, modifiable par tous.
const guideHidden = ref(readJson<unknown>(GUIDE_HIDDEN_KEY, false) === true);
function showGuide() {
  writeJson(GUIDE_HIDDEN_KEY, false);
  guideHidden.value = false;
}

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
    <div class="mt-5 border-t border-slate-100 pt-4 text-sm">
      <p class="font-medium">Aide de la page Images</p>
      <p class="mt-1 text-xs text-slate-500">Le parcours « Corriger une image » peut être fermé depuis la page Images ; ce réglage est propre à ce navigateur.</p>
      <button type="button" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50" :disabled="!guideHidden" @click="showGuide">
        {{ guideHidden ? "Réafficher l’aide" : "L’aide est affichée" }}
      </button>
    </div>
  </PanelCard>
</template>
