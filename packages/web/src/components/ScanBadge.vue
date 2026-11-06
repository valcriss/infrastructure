<script setup lang="ts">
import { computed } from "vue";
import { ago, fmtDate, type ImageScanView } from "../api";

const props = defineProps<{ scan: ImageScanView }>();

const label = computed(() => {
  const s = props.scan;
  switch (s.state) {
    case "never":
      return { text: "jamais scannée", cls: "bg-slate-200 text-slate-700" };
    case "pending":
      return { text: "scan en attente", cls: "bg-blue-100 text-blue-800" };
    case "running":
      return { text: "scan en cours", cls: "bg-blue-100 text-blue-800" };
    case "failed":
      return { text: "scan en échec", cls: "bg-red-100 text-red-800" };
    case "clean":
      return { text: "aucune vulnérabilité connue", cls: "bg-green-100 text-green-800" };
    default:
      return { text: `${s.current?.total ?? 0} vulnérabilité(s)`, cls: (s.current?.counts?.critical ?? 0) > 0 ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800" };
  }
});
const counts = computed(() => props.scan.current?.counts);
</script>

<template>
  <div class="space-y-1 text-xs">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="rounded px-2 py-0.5" :class="label.cls">{{ label.text }}</span>
      <template v-if="counts && scan.current?.total">
        <span v-if="counts.critical" class="rounded bg-red-600 px-1.5 text-white" title="Critiques">{{ counts.critical }} C</span>
        <span v-if="counts.high" class="rounded bg-orange-500 px-1.5 text-white" title="Élevées">{{ counts.high }} H</span>
        <span v-if="counts.medium" class="rounded bg-amber-400 px-1.5 text-slate-900" title="Moyennes">{{ counts.medium }} M</span>
        <span v-if="counts.low" class="rounded bg-slate-300 px-1.5 text-slate-800" title="Faibles">{{ counts.low }} L</span>
        <span v-if="counts.unknown" class="rounded bg-slate-200 px-1.5 text-slate-700" title="Inconnues">{{ counts.unknown }} ?</span>
      </template>
      <span v-if="scan.stale" class="rounded bg-amber-100 px-1.5 text-amber-800">périmé</span>
    </div>
    <p v-if="scan.state === 'failed'" class="max-w-md text-red-700">{{ scan.lastAttempt?.error }}</p>
    <p v-if="scan.current" class="text-slate-500" :title="fmtDate(scan.current.finishedAt)">
      Scanné {{ ago(scan.current.finishedAt) }}<span v-if="scan.state === 'failed'"> (dernier succès)</span>
      · Trivy {{ scan.current.trivyVersion ?? "?" }} · base du {{ scan.current.dbUpdatedAt ? new Date(scan.current.dbUpdatedAt).toLocaleDateString("fr-FR") : "?" }}
      <span v-if="scan.current.os?.eosl" class="text-amber-700"> · {{ scan.current.os.family }} {{ scan.current.os.name }} en fin de vie</span>
    </p>
  </div>
</template>
