<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api, describeError, type ChangeResult, type Container } from "../api";
import DiffView from "./DiffView.vue";

// Image personnalisée : ajoute des outils (curl…) et/ou applique les mises à jour du système à l'image d'un service.
// Un Dockerfile est généré (modifiable) et enregistré avec le Compose dans une nouvelle révision ; rien n'est déployé.
const props = defineProps<{ stackId: string; hostId: string; revision: number; service: string; container: Container }>();
const emit = defineEmits<{ close: []; saved: [revision: number] }>();

type Pm = "apk" | "apt-get" | "dnf" | "microdnf" | "yum" | "zypper";
interface Probe { tools: string[]; packageManager: Pm | null; packageManagers?: Pm[]; os?: string | null; user: string; shell: boolean }

const probe = ref<Probe | null>(null);
const probing = ref(true);
const probeNote = ref("");
/** Gestionnaires de paquets trouvés dans le conteneur (le premier est présélectionné). */
const detected = ref<Pm[]>([]);
/** D'où vient le gestionnaire choisi : trouvé dans le conteneur, déduit du nom de l'image, ou à choisir soi-même. */
const pmSource = ref<"detected" | "guessed" | "manual">("manual");
/** L'image a été sondée mais n'offre aucun moyen d'installer des paquets (pas de gestionnaire, ou pas de shell). */
const noInstaller = ref(false);
const probeFailed = ref(false);

const pm = ref<Pm>("apt-get");
const upgrade = ref(false);
const picked = reactive<Record<string, boolean>>({});
const extra = ref("");

/** Outils proposés, avec le nom du paquet selon le gestionnaire de paquets. */
const TOOLS: { key: string; label: string; pkg: (p: Pm) => string }[] = [
  { key: "curl", label: "curl", pkg: () => "curl" },
  { key: "wget", label: "wget", pkg: () => "wget" },
  { key: "bash", label: "bash", pkg: () => "bash" },
  { key: "nc", label: "netcat (nc)", pkg: (p) => (p === "dnf" || p === "microdnf" || p === "yum" ? "nmap-ncat" : "netcat-openbsd") },
  { key: "ca", label: "certificats (ca-certificates)", pkg: () => "ca-certificates" },
];
const present = (key: string): boolean => (key === "ca" ? false : (probe.value?.tools ?? []).includes(key));

const packages = computed(() => [
  ...TOOLS.filter((t) => picked[t.key] && !present(t.key)).map((t) => t.pkg(pm.value)),
  ...extra.value.split(/[\s,]+/).filter(Boolean),
]);

// --- Aperçu (Dockerfile généré + Compose modifié) -------------------------------------------------------
const dockerfile = ref("");
const edited = ref(false);
const before = ref("");
const after = ref("");
const dockerfilePath = ref("");
const image = ref("");
const message = ref("");
const error = ref("");
const busy = ref(false);

/** Gestionnaire probable d'après le nom de l'image (heuristique du serveur), utilisé seulement si la sonde est impossible. */
const guess = ref<Pm | null>(null);

const body = () => ({
  expectedRevision: props.revision,
  packageManager: pm.value,
  packages: packages.value,
  upgrade: upgrade.value,
  user: probe.value?.user ?? "",
  ...(edited.value ? { dockerfile: dockerfile.value } : {}),
});
const url = () => `/api/v1/stacks/${props.stackId}/services/${encodeURIComponent(props.service)}/custom-image`;

let timer: number | undefined;
async function refresh() {
  error.value = "";
  try {
    const r = await api<{ dockerfilePath: string; dockerfile: string; before: string; after: string; image: string; guessedPackageManager?: Pm | null }>(`${url()}/preview`, { method: "POST", body: JSON.stringify(body()) });
    if (!edited.value) dockerfile.value = r.dockerfile;
    before.value = r.before;
    after.value = r.after;
    dockerfilePath.value = r.dockerfilePath;
    image.value = r.image;
    guess.value = r.guessedPackageManager ?? null;
  } catch (err) {
    error.value = describeError(err);
  }
}
watch([pm, upgrade, packages], () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), 300);
});

onMounted(async () => {
  try {
    const p = await api<Probe>(`/api/v1/hosts/${props.hostId}/containers/${props.container.id}/tools`, { method: "POST" });
    probe.value = p;
    detected.value = p.packageManagers?.length ? p.packageManagers : p.packageManager ? [p.packageManager] : [];
    if (!p.shell) {
      noInstaller.value = true;
      probeNote.value = "Cette image n'a pas de shell : aucun paquet ne peut être installé par un Dockerfile simple. Modifiez-le à la main (construction en plusieurs étapes).";
    } else if (detected.value.length === 0) {
      noInstaller.value = true;
      probeNote.value = `Aucun gestionnaire de paquets disponible dans cette image${p.os ? ` (distribution : ${p.os})` : ""} : il n'est pas possible d'ajouter des outils ni d'appliquer des mises à jour avec un Dockerfile simple. Modifiez-le à la main (construction en plusieurs étapes).`;
    } else {
      pm.value = detected.value[0] as Pm;
      pmSource.value = "detected";
      for (const t of TOOLS) if (t.key !== "ca" && !p.tools.includes(t.key) && (t.key === "curl" || t.key === "wget")) picked[t.key] = t.key === "curl";
    }
  } catch (err) {
    probeFailed.value = true;
    probeNote.value = `Détection impossible (${describeError(err)}).`;
  } finally {
    probing.value = false;
  }
  await refresh();
  // Sonde impossible (conteneur arrêté…) : on propose le gestionnaire le plus probable d'après le nom de l'image.
  if (probeFailed.value && guess.value) {
    pm.value = guess.value;
    pmSource.value = "guessed";
  }
});
onBeforeUnmount(() => window.clearTimeout(timer));

async function save() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api<ChangeResult>(url(), { method: "PATCH", body: JSON.stringify({ ...body(), dockerfile: dockerfile.value, ...(message.value ? { message: message.value } : {}) }) });
    emit("saved", r.revision);
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

const input = "rounded border border-slate-300 px-3 py-2";
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="`Image personnalisée pour ${service}`" class="w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">Image personnalisée pour « {{ service }} »</h2>
          <p class="text-xs text-slate-500">Base : {{ container.image }} · le résultat est enregistré dans une nouvelle révision, sans déploiement</p>
        </div>
        <button class="rounded p-2 text-slate-500 hover:bg-slate-100" aria-label="Fermer" @click="emit('close')"><FaIcon :icon="['fas', 'xmark']" /></button>
      </header>

      <div class="space-y-4 p-6 text-sm">
        <p class="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Une image personnalisée est <strong>construite sur l'hôte</strong> à chaque déploiement (avec cache). Son <strong>image de base</strong> (ligne FROM du Dockerfile) reste suivie par la vérification
          des versions ; les paquets que vous ajoutez sont reconstruits à chaque déploiement, et une nouvelle version de l'image de base n'est reprise qu'avec « Télécharger les images ».
          Ajouter des outils ajoute aussi leurs vulnérabilités éventuelles.
        </p>
        <p v-if="probing" class="rounded bg-slate-100 p-3 text-slate-700">Analyse de l'image du conteneur…</p>
        <p v-else-if="pmSource === 'detected'" role="status" class="rounded border border-green-200 bg-green-50 p-3 text-green-900">
          Gestionnaire de paquets détecté automatiquement : <strong>{{ pm }}</strong><template v-if="probe?.os"> (distribution : {{ probe.os }})</template>.
          <template v-if="detected.length > 1">Également disponibles : {{ detected.filter((d) => d !== pm).join(", ") }}.</template>
        </p>
        <p v-else-if="probeNote" :class="['rounded p-3', noInstaller ? 'border border-amber-300 bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700']">
          {{ probeNote }}
          <template v-if="pmSource === 'guessed'">Gestionnaire <strong>supposé</strong> d'après le nom de l'image : <strong>{{ pm }}</strong>. Démarrez le conteneur pour le confirmer.</template>
          <template v-else-if="probeFailed">Choisissez le gestionnaire de paquets de l'image si vous le connaissez.</template>
        </p>

        <div class="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend class="mb-1 font-medium">Outils à ajouter</legend>
            <label v-for="t in TOOLS" :key="t.key" class="flex items-center gap-2 py-0.5" :class="{ 'opacity-50': present(t.key) || noInstaller }">
              <input v-model="picked[t.key]" type="checkbox" :disabled="present(t.key) || noInstaller" /> {{ t.label }}
              <span v-if="present(t.key)" class="text-xs text-green-700">déjà présent</span>
            </label>
            <label class="mt-2 block text-xs">
              <span class="block font-medium">Autres paquets (séparés par des espaces)</span>
              <input v-model="extra" :disabled="noInstaller" placeholder="ex. jq git" :class="[input, 'mt-1 w-full']" />
            </label>
          </fieldset>
          <div class="space-y-3">
            <label class="flex items-start gap-2" :class="{ 'opacity-50': noInstaller }">
              <input v-model="upgrade" type="checkbox" class="mt-1" :disabled="noInstaller" />
              <span><span class="font-medium">Mettre à jour les paquets du système</span><span class="block text-xs text-slate-500">Applique les correctifs disponibles (corrige les CVE du système qui ont un correctif). Les CVE des bibliothèques de l'application ne sont pas concernées.</span></span>
            </label>
            <label class="block">
              <span class="mb-1 block font-medium">Gestionnaire de paquets</span>
              <select v-model="pm" :disabled="noInstaller" :class="[input, 'w-full']" @change="pmSource = detected.includes(pm) ? 'detected' : 'manual'">
                <option v-for="p in ['apk', 'apt-get', 'dnf', 'microdnf', 'yum', 'zypper']" :key="p" :value="p">{{ p }}{{ detected.includes(p as Pm) ? " (détecté)" : "" }}</option>
              </select>
            </label>
          </div>
        </div>

        <label class="block">
          <span class="mb-1 block font-medium">Dockerfile <span class="font-normal text-slate-500">({{ dockerfilePath || "build/…/Dockerfile" }}) — modifiable</span></span>
          <textarea v-model="dockerfile" rows="9" spellcheck="false" :class="[input, 'w-full font-mono text-xs']" @input="edited = true"></textarea>
          <span v-if="edited" class="mt-1 block text-xs text-amber-700">Modifié à la main : les choix ci-dessus ne le régénèrent plus.</span>
        </label>

        <div>
          <p class="mb-1 font-medium">Changement du Compose <span class="font-normal text-slate-500">(l'image devient « {{ image || "…" }} », construite à partir du Dockerfile)</span></p>
          <DiffView :before="before" :after="after" />
        </div>
        <input v-model="message" maxlength="200" placeholder="Message de révision (optionnel)" aria-label="Message de révision" :class="[input, 'w-full']" />
      </div>

      <p v-if="error" role="alert" class="px-6 text-sm text-red-700">{{ error }}</p>
      <footer class="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 text-sm">
        <button class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="emit('close')">Annuler</button>
        <button :disabled="busy || probing || !dockerfile || !!error" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="save">Enregistrer une révision</button>
      </footer>
    </div>
  </div>
</template>
