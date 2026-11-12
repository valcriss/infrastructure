<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, describeError, type StackDetail } from "../../api";
import AppIcon from "../../components/AppIcon.vue";
import PanelCard from "../../components/PanelCard.vue";
import { useSession } from "../../stores/session";

// Apparence : icône (SVG) et couleur de fond de l'application. Hors des révisions : aucun déploiement n'est nécessaire.
const props = defineProps<{ stack: StackDetail }>();
const emit = defineEmits<{ changed: [] }>();

const MAX_BYTES = 32 * 1024;
const session = useSession();
const busy = ref(false);
const error = ref("");
const info = ref("");

// Brouillon : le SVG choisi (texte) et la couleur ; rien n'est enregistré avant « Enregistrer ».
const svg = ref<string | null | undefined>(undefined); // undefined : inchangé ; null : retirer ; texte : nouveau SVG
const color = ref<string | null>(props.stack.iconColor);
watch(() => props.stack.iconColor, (c) => { if (!dirty.value) color.value = c; });

const dirty = computed(() => svg.value !== undefined || color.value !== props.stack.iconColor);
const previewSrc = computed(() => (typeof svg.value === "string" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.value)}` : null));
// L'icône enregistrée est masquée dans l'aperçu quand on la retire (svg === null).
const shownTag = computed(() => (svg.value === null ? null : props.stack.iconTag));
const hasAny = computed(() => !!props.stack.iconTag || !!props.stack.iconColor);

async function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  error.value = info.value = "";
  if (!file) return;
  if (file.size > MAX_BYTES) {
    error.value = `Fichier trop volumineux (${MAX_BYTES / 1024} Kio au plus).`;
    return;
  }
  svg.value = await file.text();
}

async function save() {
  error.value = info.value = "";
  busy.value = true;
  try {
    const body: { svg?: string | null; color?: string | null } = {};
    if (svg.value !== undefined) body.svg = svg.value;
    if (color.value !== props.stack.iconColor) body.color = color.value;
    await api(`/api/v1/stacks/${props.stack.id}/icon`, { method: "PUT", body: JSON.stringify(body) });
    svg.value = undefined;
    info.value = "Apparence enregistrée. Aucun déploiement n'est nécessaire.";
    emit("changed");
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function reset() {
  if (!window.confirm("Rétablir l'icône et la couleur par défaut ?")) return;
  svg.value = null;
  color.value = null;
  void save();
}
function discard() {
  svg.value = undefined;
  color.value = props.stack.iconColor;
  error.value = "";
}

const ghost = "rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50";
const primary = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
</script>

<template>
  <div class="space-y-4">
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="info" role="status" class="text-sm text-green-700">{{ info }}</p>
    <PanelCard title="Apparence" icon="palette" subtitle="Icône et couleur affichées dans la liste des applications">
      <div class="flex flex-wrap items-start gap-6">
        <div class="space-y-2">
          <p class="text-xs text-slate-500">Aperçu</p>
          <div class="flex items-center gap-3">
            <AppIcon :stack-id="stack.id" :icon-tag="shownTag" :icon-color="color" :preview-src="previewSrc" />
            <AppIcon :stack-id="stack.id" :icon-tag="shownTag" :icon-color="color" :preview-src="previewSrc" size="sm" />
          </div>
        </div>

        <div class="min-w-64 flex-1 space-y-4 text-sm">
          <div>
            <span class="font-medium">Icône (SVG)</span>
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <label :class="[ghost, 'cursor-pointer', !session.canOperate || busy ? 'pointer-events-none opacity-50' : '']">
                Choisir un fichier SVG…
                <input type="file" accept=".svg,image/svg+xml" class="sr-only" :disabled="!session.canOperate || busy" @change="pick" />
              </label>
              <button v-if="stack.iconTag && svg !== null" type="button" :class="ghost" :disabled="!session.canOperate || busy" @click="svg = null">Retirer l'icône</button>
              <span v-if="typeof svg === 'string'" class="text-xs text-slate-500">Nouveau fichier prêt à enregistrer.</span>
              <span v-else-if="svg === null" class="text-xs text-slate-500">L'icône par défaut sera rétablie.</span>
            </div>
            <p class="mt-1 text-xs text-slate-500">
              SVG uniquement, 32 Kio au plus, avec un <code>viewBox</code>. Les scripts, liens et ressources externes sont refusés.
              Sans icône, l'icône par défaut est conservée.
            </p>
          </div>

          <div>
            <span class="font-medium">Couleur de fond</span>
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <input
                type="color"
                :value="color ?? '#dbeafe'"
                aria-label="Couleur de fond"
                class="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white p-1"
                :disabled="!session.canOperate || busy"
                @input="color = ($event.target as HTMLInputElement).value"
              />
              <span class="font-mono text-xs text-slate-600">{{ color ?? "par défaut" }}</span>
              <button v-if="color" type="button" :class="ghost" :disabled="!session.canOperate || busy" @click="color = null">Couleur par défaut</button>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <button :class="primary" :disabled="!session.canOperate || busy || !dirty" @click="save">Enregistrer</button>
        <button :class="ghost" :disabled="busy || !dirty" @click="discard">Annuler</button>
        <button v-if="hasAny" :class="ghost" :disabled="!session.canOperate || busy" @click="reset">Tout rétablir par défaut</button>
      </div>
    </PanelCard>
  </div>
</template>
