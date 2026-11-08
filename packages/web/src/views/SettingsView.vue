<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import PageTitle from "../components/PageTitle.vue";
import DisplaySettings from "./settings/DisplaySettings.vue";
import GitSettings from "./settings/GitSettings.vue";
import SecuritySettings from "./settings/SecuritySettings.vue";
import TerminalSettings from "./settings/TerminalSettings.vue";
import UsersSettings from "./settings/UsersSettings.vue";
import { useSession } from "../stores/session";

// Paramètres de l'application (distincts des paramètres de l'utilisateur, voir AccountView).
const ALL_TABS = [
  { key: "git", label: "Sauvegarde Git", icon: "cloud-arrow-up", adminOnly: false },
  { key: "security", label: "Sécurité des images", icon: "shield-halved", adminOnly: false },
  { key: "display", label: "Affichage", icon: "eye", adminOnly: false },
  { key: "users", label: "Utilisateurs", icon: "users", adminOnly: true },
  { key: "terminal", label: "Terminal", icon: "terminal", adminOnly: true },
] as const;

const route = useRoute();
const router = useRouter();
const session = useSession();
const TABS = computed(() => ALL_TABS.filter((t) => !t.adminOnly || session.isAdmin));
const tab = computed(() => TABS.value.find((t) => t.key === route.query.tab)?.key ?? "git");
const select = (key: string) => router.replace({ path: "/settings", query: { tab: key } });
</script>

<template>
  <div class="space-y-6">
    <PageTitle title="Paramètres de l'application" icon="gear" subtitle="Sauvegarde Git, périodicité des scans et registres d'images" />

    <div role="tablist" aria-label="Sections des paramètres" class="flex flex-wrap gap-1 border-b border-slate-200">
      <button
        v-for="t in TABS"
        :key="t.key"
        role="tab"
        :aria-selected="tab === t.key"
        class="-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm"
        :class="tab === t.key ? 'border-blue-600 font-medium text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'"
        @click="select(t.key)"
      >
        <FaIcon :icon="['fas', t.icon]" />
        {{ t.label }}
      </button>
    </div>

    <GitSettings v-if="tab === 'git'" />
    <SecuritySettings v-else-if="tab === 'security'" />
    <DisplaySettings v-else-if="tab === 'display'" />
    <UsersSettings v-else-if="tab === 'users'" />
    <TerminalSettings v-else />
  </div>
</template>
