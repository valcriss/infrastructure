<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { currentStep, guideSteps, type RegistrySetup } from "../guide";

// Parcours d'un correctif d'image, de la mise en place du registre au déploiement : où en est-on, et quelle est la suite.
const props = defineProps<{ scannedImages: number; jobs: number; toReview: number; applied: number }>();

const registry = ref<RegistrySetup | null>(null);
const loaded = ref(false);

onMounted(async () => {
  try {
    registry.value = await api<RegistrySetup>("/api/v1/settings/registry");
  } catch {
    registry.value = null; // la lecture du parcours ne doit jamais gêner la page
  } finally {
    loaded.value = true;
  }
});

const steps = computed(() => guideSteps({ registry: registry.value, scannedImages: props.scannedImages, jobs: props.jobs, toReview: props.toReview, applied: props.applied }));
const current = computed(() => currentStep(steps.value));
// Tant que le registre n'est pas en place, le parcours est ouvert : c'est la première chose à faire.
const setupDone = computed(() => steps.value.slice(0, 2).every((s) => s.done));
const open = ref<boolean | null>(null);
const isOpen = computed(() => open.value ?? !setupDone.value);
</script>

<template>
  <details v-if="loaded" class="rounded-xl border border-slate-200 bg-white" :open="isOpen" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary class="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm font-medium">
      <FaIcon :icon="['fas', 'route']" class="text-slate-500" />
      Corriger une image : le parcours
      <span v-if="current" class="font-normal text-slate-600">· prochaine étape : <strong>{{ current.title }}</strong></span>
      <span v-else class="font-normal text-green-700">· tout est en place</span>
    </summary>
    <ol class="space-y-2 border-t border-slate-100 px-4 py-3 text-sm" aria-label="Étapes du correctif">
      <li v-for="(s, n) in steps" :key="s.id" class="flex items-start gap-3">
        <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold" :class="s.done ? 'bg-green-100 text-green-800' : s.id === current?.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'" :aria-label="s.done ? 'terminée' : s.id === current?.id ? 'à faire maintenant' : 'à venir'">
          <FaIcon v-if="s.done" :icon="['fas', 'circle-check']" />
          <template v-else>{{ n + 1 }}</template>
        </span>
        <div>
          <p class="font-medium" :class="s.id === current?.id ? 'text-slate-900' : 'text-slate-700'">{{ s.title }}</p>
          <p class="text-xs text-slate-600">{{ s.text }}</p>
          <RouterLink v-if="s.to && (!s.done || s.id === 'deploy')" :to="s.to" class="text-xs font-medium text-blue-600 underline">{{ s.action ?? "Ouvrir" }}</RouterLink>
        </div>
      </li>
    </ol>
    <p class="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Rien n'est jamais déployé automatiquement : à chaque étape, vous gardez la main.</p>
  </details>
</template>
