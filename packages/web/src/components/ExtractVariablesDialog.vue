<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { api, describeError, type ChangeResult } from "../api";
import DiffView from "./DiffView.vue";

// Extrait les valeurs écrites en clair dans `environment` en variables de stack (${NOM}) : on choisit lesquelles,
// et lesquelles chiffrer. Une seule révision contient le Compose modifié et les variables ; rien n'est déployé.
const props = defineProps<{ stackId: string }>();
const emit = defineEmits<{ close: []; saved: [revision: number, count: number] }>();

interface Group {
  id: string;
  name: string;
  value: string;
  secret: boolean;
  shared: boolean;
  reuse: boolean;
  uses: { service: string; key: string }[];
}
interface Proposal { revision: number; groups: Group[]; skipped: { service: string; key?: string; reason: string }[]; existing: string[] }
interface Row extends Group {
  checked: boolean;
  encrypted: boolean;
  /** Nom d'origine proposé : une variable existante de même valeur n'est « réutilisée » que sous ce nom. */
  original: string;
  reveal: boolean;
}

const loading = ref(true);
const proposal = ref<Proposal | null>(null);
const rows = reactive<Row[]>([]);
const onlySecrets = ref(false);
const error = ref("");
const busy = ref(false);

onMounted(async () => {
  try {
    const p = await api<Proposal>(`/api/v1/stacks/${props.stackId}/variables/extraction`);
    proposal.value = p;
    // Les secrets détectés sont cochés et chiffrés d'office ; le reste est laissé au choix de l'utilisateur.
    rows.push(...p.groups.map((g) => ({ ...g, checked: g.secret, encrypted: g.secret, original: g.name, reveal: false })));
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
});

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const existing = computed(() => new Set(proposal.value?.existing ?? []));
const reuses = (r: Row): boolean => r.reuse && r.name === r.original && r.encrypted === r.secret;

/** Problème bloquant d'une ligne cochée (null si elle est valide) : nom invalide, en double ou déjà pris. */
function problem(r: Row): string | null {
  if (!r.checked) return null;
  if (!NAME.test(r.name)) return "Nom invalide (lettres, chiffres et « _ », sans commencer par un chiffre).";
  if (rows.some((o) => o !== r && o.checked && o.name === r.name)) return "Ce nom est déjà utilisé par une autre valeur de cette liste : un nom ne peut désigner qu'une valeur.";
  if (existing.value.has(r.name) && !reuses(r)) return "Une variable de ce nom existe déjà avec une autre valeur ou un autre réglage de chiffrement.";
  return null;
}
const warning = (r: Row): string | null => (r.checked && r.name.includes("__") ? "Évitez le double underscore « __ » dans les noms." : null);

const visible = computed(() => rows.filter((r) => !onlySecrets.value || r.secret));
const selected = computed(() => rows.filter((r) => r.checked));
const blocking = computed(() => selected.value.some((r) => problem(r) !== null));
const uses = (r: Row): string => r.uses.map((u) => `${u.service} · ${u.key}`).join("\n");
const masked = (r: Row): string => (r.reveal || !r.encrypted ? r.value : "•".repeat(Math.min(12, Math.max(6, r.value.length))));

function checkSecrets(on: boolean) {
  for (const r of rows) if (r.secret) {
    r.checked = on;
    r.encrypted = on ? true : r.secret;
  }
}
function checkAll(on: boolean) {
  for (const r of visible.value) r.checked = on;
}

// --- Aperçu puis enregistrement ----------------------------------------------------------------------
const step = ref<"select" | "diff">("select");
const before = ref("");
const after = ref("");
const created = ref<{ name: string; sensitive: boolean; reused: boolean; uses: number }[]>([]);
const message = ref("");

const body = () => ({
  expectedRevision: proposal.value?.revision ?? 0,
  groups: selected.value.map((r) => ({ name: r.name, encrypted: r.encrypted, uses: r.uses })),
});

async function preview() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<{ before: string; after: string; variables: typeof created.value }>(`/api/v1/stacks/${props.stackId}/variables/extraction/preview`, { method: "POST", body: JSON.stringify(body()) });
    before.value = r.before;
    after.value = r.after;
    created.value = r.variables;
    step.value = "diff";
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function save() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<ChangeResult>(`/api/v1/stacks/${props.stackId}/variables/extraction`, { method: "POST", body: JSON.stringify({ ...body(), ...(message.value ? { message: message.value } : {}) }) });
    emit("saved", r.revision, selected.value.length);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

const input = "rounded border border-slate-300 px-2 py-1";
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" aria-label="Extraire les variables du Compose" class="w-full max-w-5xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">Extraire les variables du Compose</h2>
          <p class="text-xs text-slate-500">{{ step === "select" ? "1/2 Choisir les valeurs à transformer en variables" : "2/2 Différences du Compose" }} · rien n'est déployé</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div v-if="step === 'select'" class="space-y-4 p-6 text-sm">
        <p v-if="loading" class="text-slate-500">Analyse du Compose…</p>
        <p v-else-if="rows.length === 0" class="rounded bg-slate-100 p-3 text-slate-700">Aucune valeur littérale à extraire : les valeurs de « environment » sont déjà des variables, ou absentes.</p>
        <template v-else>
          <p class="text-slate-600">
            Les valeurs écrites en clair dans <code>environment</code> sont proposées ci-dessous. Cochez celles à remplacer par <code>${NOM}</code> et celles à chiffrer (valeur masquée, chiffrée dans la sauvegarde Git).
            Les secrets détectés sont cochés et chiffrés d'office ; une valeur utilisée par plusieurs services devient une seule variable partagée.
          </p>
          <div class="flex flex-wrap items-center gap-3 text-xs">
            <button class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="checkSecrets(true)">Cocher les secrets</button>
            <button class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="checkAll(true)">Tout cocher</button>
            <button class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="checkAll(false)">Tout décocher</button>
            <label class="flex items-center gap-1.5"><input v-model="onlySecrets" type="checkbox" /> Seulement les secrets</label>
            <span class="text-slate-500">{{ selected.length }} sélectionnée(s) sur {{ rows.length }}</span>
          </div>

          <div class="overflow-x-auto rounded border border-slate-200">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-50 text-slate-500">
                <tr><th class="px-3 py-2">Extraire</th><th class="px-3 py-2">Variable</th><th class="px-3 py-2">Valeur</th><th class="px-3 py-2">Utilisée par</th><th class="px-3 py-2">Chiffrée</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in visible" :key="r.id" class="border-t border-slate-100 align-top" :class="{ 'bg-slate-50 opacity-70': !r.checked }">
                  <td class="px-3 py-2"><input v-model="r.checked" type="checkbox" :aria-label="`Extraire ${r.name}`" /></td>
                  <td class="px-3 py-2">
                    <input v-model="r.name" :disabled="!r.checked" :aria-label="`Nom de la variable pour ${r.original}`" :class="[input, 'w-64 font-mono', problem(r) ? 'border-red-400' : '']" />
                    <p v-if="problem(r)" class="mt-1 max-w-xs text-red-700">{{ problem(r) }}</p>
                    <p v-else-if="warning(r)" class="mt-1 max-w-xs text-amber-700">{{ warning(r) }}</p>
                    <p v-else-if="r.checked && reuses(r)" class="mt-1 text-blue-700">Variable existante réutilisée</p>
                  </td>
                  <td class="px-3 py-2">
                    <span class="break-all font-mono">{{ masked(r) }}</span>
                    <button v-if="r.encrypted" class="ml-2 underline" @click="r.reveal = !r.reveal">{{ r.reveal ? "masquer" : "afficher" }}</button>
                  </td>
                  <td class="px-3 py-2">
                    <ul class="space-y-0.5">
                      <li v-for="u in r.uses" :key="u.service + u.key" class="whitespace-nowrap"><span class="text-slate-500">{{ u.service }}</span> · <span class="font-mono">{{ u.key }}</span></li>
                    </ul>
                    <span v-if="r.shared" class="mt-1 inline-block rounded bg-blue-100 px-1.5 py-0.5 text-blue-800" :title="uses(r)">partagée</span>
                    <span v-if="r.secret" class="mt-1 ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">secret probable</span>
                  </td>
                  <td class="px-3 py-2"><input v-model="r.encrypted" type="checkbox" :disabled="!r.checked" :aria-label="`Chiffrer ${r.name}`" /></td>
                </tr>
              </tbody>
            </table>
          </div>

          <details v-if="proposal?.skipped.length" class="text-xs text-slate-600">
            <summary class="cursor-pointer">{{ proposal.skipped.length }} élément(s) ignoré(s)</summary>
            <ul class="mt-1 list-disc space-y-0.5 pl-5">
              <li v-for="s in proposal.skipped" :key="s.service + (s.key ?? '') + s.reason">{{ s.service }}<template v-if="s.key"> · {{ s.key }}</template> : {{ s.reason }}</li>
            </ul>
          </details>
        </template>
      </div>

      <div v-else class="space-y-3 p-6 text-sm">
        <p class="text-slate-600">{{ created.filter((c) => !c.reused).length }} variable(s) seront créées<template v-if="created.some((c) => c.reused)">, {{ created.filter((c) => c.reused).length }} réutilisée(s)</template> :</p>
        <ul class="flex flex-wrap gap-2 text-xs">
          <li v-for="c in created" :key="c.name" class="rounded-full border border-slate-300 px-2.5 py-0.5 font-mono">
            {{ c.name }}<span v-if="c.sensitive" class="ml-1 text-amber-700">chiffrée</span><span v-if="c.reused" class="ml-1 text-blue-700">existante</span>
          </li>
        </ul>
        <DiffView :before="before" :after="after" />
        <p class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <strong>Les anciennes valeurs restent dans l'historique.</strong> Les révisions précédentes et la sauvegarde Git contiennent encore les valeurs d'origine : changez les identifiants concernés (mots de passe, clés d'accès…) si vous les jugez exposés.
          La configuration appliquée reste identique : un déploiement ne recréera pas les conteneurs pour ce seul changement.
        </p>
        <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" :class="[input, 'w-full py-2']" />
      </div>

      <p v-if="error" role="alert" class="px-6 text-sm text-red-700">{{ error }}</p>
      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="step === 'diff' ? (step = 'select') : emit('close')">{{ step === "diff" ? "Retour" : "Annuler" }}</button>
        <button v-if="step === 'select'" :disabled="busy || selected.length === 0 || blocking" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="preview">Voir les différences</button>
        <button v-else :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
      </footer>
    </div>
  </div>
</template>
