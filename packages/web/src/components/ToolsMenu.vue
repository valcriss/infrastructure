<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

// Menu « Outils » : regroupe les actions secondaires d'un éditeur (transformations du contenu) pour ne pas allonger
// la barre de boutons. Ajouter un outil = ajouter une entrée à `items`.
export interface ToolItem {
  id: string;
  label: string;
  description: string;
  /** Raison affichée quand l'outil est indisponible (il reste visible, grisé). */
  disabledReason?: string;
}
defineProps<{ items: ToolItem[]; label?: string }>();
const emit = defineEmits<{ select: [id: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    list.value?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }
}
function pick(item: ToolItem) {
  if (item.disabledReason) return;
  open.value = false;
  emit("select", item.id);
}
function onKey(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === "Escape") {
    open.value = false;
    root.value?.querySelector<HTMLButtonElement>("button")?.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const buttons = [...(list.value?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    e.preventDefault();
  }
}
const onDocClick = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
};
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div ref="root" class="relative">
    <button type="button" class="inline-flex items-center gap-2 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
      <FaIcon :icon="['fas', 'wrench']" /> {{ label ?? "Outils" }} <FaIcon :icon="['fas', 'chevron-down']" class="text-xs" />
    </button>
    <div v-if="open" ref="list" role="menu" class="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
      <button
        v-for="i in items"
        :key="i.id"
        role="menuitem"
        type="button"
        :disabled="!!i.disabledReason"
        class="block w-full rounded px-3 py-2 text-left hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        @click="pick(i)"
      >
        <span class="block text-sm font-medium">{{ i.label }}</span>
        <span class="block text-xs text-slate-500">{{ i.disabledReason ?? i.description }}</span>
      </button>
    </div>
  </div>
</template>
