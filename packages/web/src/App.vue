<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import SideNav from "./layout/SideNav.vue";
import TopBar from "./layout/TopBar.vue";
import { useHealth } from "./stores/health";
import { useSession } from "./stores/session";
import { useUi } from "./stores/ui";

const session = useSession();
const ui = useUi();
const route = useRoute();
// Connexion et assistant d'initialisation s'affichent sans le cadre de l'application.
const framed = computed(() => Boolean(session.username) && !route.meta.public);
const health = useHealth();
// L'indicateur de santé du header n'interroge la console que lorsqu'on est connecté.
watch(framed, (on) => (on ? health.start() : health.stop()), { immediate: true });
</script>

<template>
  <template v-if="framed">
    <TopBar />
    <SideNav />
    <div :class="['pt-14 transition-all duration-200', ui.collapsed ? 'lg:pl-16' : 'lg:pl-60']">
      <div v-if="!session.hasRestorationKey" role="alert" class="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
        <FaIcon :icon="['fas', 'triangle-exclamation']" class="mr-1" />
        Aucune clé de restauration : les secrets ne peuvent pas être sauvegardés dans Git.
        <RouterLink to="/settings?tab=git" class="underline">Générer la clé</RouterLink>
      </div>
      <main class="w-full px-4 py-6 lg:px-8">
        <RouterView />
      </main>
    </div>
  </template>
  <main v-else class="mx-auto w-full max-w-5xl px-4 py-8">
    <RouterView />
  </main>
</template>
