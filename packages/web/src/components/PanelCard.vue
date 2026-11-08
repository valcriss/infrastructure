<script setup lang="ts">
import { useId } from "vue";

// Carte du tableau de bord. `collapsible` : le titre devient un bouton qui replie le contenu (l'état est porté par
// l'appelant avec v-model:collapsed, qui le mémorise si besoin). Le sous-titre reste visible quand la carte est repliée.
defineProps<{ title: string; icon?: string; subtitle?: string; collapsible?: boolean }>();
const collapsed = defineModel<boolean>("collapsed", { default: false });
const bodyId = useId();
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <header class="flex items-start justify-between gap-3" :class="collapsible && collapsed ? '' : 'mb-4'">
      <div>
        <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-600">
          <button
            v-if="collapsible"
            type="button"
            class="flex items-center gap-2 uppercase tracking-wide hover:text-slate-900"
            :aria-expanded="!collapsed"
            :aria-controls="bodyId"
            :title="(collapsed ? 'Déplier ' : 'Replier ') + title"
            @click="collapsed = !collapsed"
          >
            <FaIcon :icon="['fas', collapsed ? 'chevron-right' : 'chevron-down']" class="w-3 text-xs text-slate-400" />
            <FaIcon v-if="icon" :icon="['fas', icon]" class="text-slate-400" />
            {{ title }}
          </button>
          <span v-else class="flex items-center gap-2">
            <FaIcon v-if="icon" :icon="['fas', icon]" class="text-slate-400" />
            {{ title }}
          </span>
        </h2>
        <p v-if="subtitle" class="mt-0.5 text-xs text-slate-500" :class="collapsible ? 'cursor-pointer' : ''" @click="collapsible && (collapsed = !collapsed)">{{ subtitle }}</p>
      </div>
      <slot name="actions" :collapsed="collapsed" />
    </header>
    <div v-show="!(collapsible && collapsed)" :id="bodyId"><slot /></div>
  </section>
</template>
