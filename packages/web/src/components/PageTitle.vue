<script setup lang="ts">
defineProps<{ title: string; icon: string; subtitle?: string }>();
</script>

<template>
  <div class="flex items-center gap-3">
    <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-lg text-blue-700"><FaIcon :icon="['fas', icon]" /></span>
    <div>
      <h1 class="text-2xl font-semibold leading-tight">{{ title }}</h1>
      <p v-if="subtitle" class="text-sm text-slate-500">{{ subtitle }}</p>
      <slot />
    </div>
  </div>
</template>
