<script setup lang="ts">
import { computed, ref, watch } from "vue";

// Icône d'une application : SVG et couleur de fond personnalisés, sinon l'icône par défaut (gérée / observée).
// Le SVG n'est jamais inséré dans la page : il est chargé par une balise <img> (aucun script ne s'y exécute).
const props = withDefaults(defineProps<{
  stackId: string | null;
  kind?: "managed" | "observed";
  iconTag?: string | null;
  iconColor?: string | null;
  /** Aperçu local (data: URL) à la place de l'icône enregistrée. */
  previewSrc?: string | null;
  size?: "sm" | "md";
}>(), { kind: "managed", iconTag: null, iconColor: null, previewSrc: null, size: "md" });

const failed = ref(false);
watch(() => [props.stackId, props.iconTag, props.previewSrc], () => (failed.value = false));

const src = computed(() => {
  if (props.previewSrc) return props.previewSrc;
  if (!props.stackId || !props.iconTag || failed.value) return null;
  return `/api/v1/stacks/${props.stackId}/icon?v=${encodeURIComponent(props.iconTag)}`;
});

/** Noir ou blanc, selon la luminance du fond choisi (lisibilité de l'icône par défaut). */
function readable(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#0f172a";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt((m[1] as string).slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0f172a" : "#ffffff";
}

const box = computed(() => (props.size === "sm" ? "h-8 w-8 text-base" : "h-10 w-10 text-lg"));
const palette = computed(() => (props.kind === "managed" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"));
const style = computed(() => (props.iconColor ? { backgroundColor: props.iconColor, color: readable(props.iconColor) } : undefined));
</script>

<template>
  <span :class="['flex shrink-0 items-center justify-center overflow-hidden rounded-lg', box, iconColor ? '' : palette]" :style="style">
    <img v-if="src" :src="src" alt="" class="h-3/4 w-3/4 object-contain" @error="failed = true" />
    <FaIcon v-else :icon="['fas', kind === 'managed' ? 'boxes-stacked' : 'eye']" />
  </span>
</template>
