<script setup lang="ts">
defineProps<{ title: string; icon?: string; subtitle?: string }>();
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <header class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
          <FaIcon v-if="icon" :icon="['fas', icon]" class="text-slate-400" />
          {{ title }}
        </h2>
        <p v-if="subtitle" class="mt-0.5 text-xs text-slate-500">{{ subtitle }}</p>
      </div>
      <slot name="actions" />
    </header>
    <slot />
  </section>
</template>
