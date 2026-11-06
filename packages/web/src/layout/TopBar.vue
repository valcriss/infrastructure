<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { PRODUCT_NAME } from "../brand";
import { useHealth } from "../stores/health";
import { useSession } from "../stores/session";
import { useTheme, type ThemeMode } from "../stores/theme";
import { useUi } from "../stores/ui";

const session = useSession();
const health = useHealth();
const HEALTH = {
  ok: { text: "Tout va bien", cls: "bg-green-100 text-green-800", dot: "bg-green-500" },
  warning: { text: "À surveiller", cls: "bg-amber-100 text-amber-800", dot: "bg-amber-500" },
  critical: { text: "Problème", cls: "bg-red-100 text-red-800", dot: "bg-red-500" },
  unknown: { text: "Statut", cls: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
} as const;
const theme = useTheme();
const ui = useUi();
const router = useRouter();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const MODES: { value: ThemeMode; label: string; icon: string }[] = [
  { value: "light", label: "Clair", icon: "sun" },
  { value: "dark", label: "Sombre", icon: "moon" },
  { value: "auto", label: "Auto", icon: "circle-half-stroke" },
];

function outside(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") open.value = false;
};
onMounted(() => {
  document.addEventListener("click", outside);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", outside);
  document.removeEventListener("keydown", onKey);
});

async function go(path: string) {
  open.value = false;
  await router.push(path);
}
async function logout() {
  open.value = false;
  await session.logout();
  await router.push("/login");
}
</script>

<template>
  <header class="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4">
    <div class="flex items-center gap-3">
      <button class="rounded p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Ouvrir le menu" @click="ui.drawerOpen = !ui.drawerOpen">
        <FaIcon :icon="['fas', 'bars']" />
      </button>
      <RouterLink to="/dashboard" class="flex items-center gap-2 font-semibold">
        <span class="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-white"><FaIcon :icon="['fas', 'cube']" /></span>
        <span>{{ PRODUCT_NAME }}</span>
      </RouterLink>
    </div>

    <div ref="root" class="relative flex items-center gap-2">
      <RouterLink to="/statut" :class="['hidden items-center gap-2 rounded-full px-3 py-1 text-xs font-medium sm:inline-flex', HEALTH[health.level].cls]" :title="health.issues ? `${health.issues} point(s) d'attention` : 'État global'">
        <span :class="['h-2 w-2 rounded-full', HEALTH[health.level].dot]" aria-hidden="true"></span>
        {{ HEALTH[health.level].text }}<template v-if="health.issues"> · {{ health.issues }}</template>
      </RouterLink>
      <button
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        aria-haspopup="menu"
        :aria-expanded="open"
        @click.stop="open = !open"
      >
        <span class="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-slate-600"><FaIcon :icon="['fas', 'user']" /></span>
        <span class="hidden sm:inline">{{ session.username }}</span>
      </button>

      <div v-if="open" role="menu" class="absolute right-0 top-11 w-64 rounded-lg border border-slate-200 bg-white py-2 shadow-lg">
        <p class="px-4 text-xs uppercase tracking-wide text-slate-500">Connecté en tant que</p>
        <p class="px-4 pb-2 font-medium">{{ session.username }}</p>
        <hr class="border-slate-200" />
        <p class="px-4 pb-1 pt-2 text-xs uppercase tracking-wide text-slate-500">Thème</p>
        <div class="flex gap-1 px-3 pb-2" role="group" aria-label="Thème">
          <button
            v-for="m in MODES"
            :key="m.value"
            :aria-pressed="theme.mode === m.value"
            :class="['flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs', theme.mode === m.value ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200']"
            @click="theme.set(m.value)"
          >
            <FaIcon :icon="['fas', m.icon]" /> {{ m.label }}
          </button>
        </div>
        <hr class="border-slate-200" />
        <button role="menuitem" class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-slate-100" @click="go('/account')">
          <FaIcon :icon="['fas', 'key']" fixed-width /> Paramètres (mot de passe)
        </button>
        <hr class="border-slate-200" />
        <button role="menuitem" class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-red-700 hover:bg-slate-100" @click="logout">
          <FaIcon :icon="['fas', 'arrow-right-from-bracket']" fixed-width /> Déconnexion
        </button>
      </div>
    </div>
  </header>
</template>
