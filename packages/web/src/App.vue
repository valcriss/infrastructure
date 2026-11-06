<script setup lang="ts">
import { useRouter } from "vue-router";
import { useSession } from "./stores/session";

const session = useSession();
const router = useRouter();

async function logout() {
  await session.logout();
  await router.push("/login");
}
</script>

<template>
  <header v-if="session.username" class="border-b border-slate-200 bg-white">
    <nav class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3" aria-label="Navigation principale">
      <div class="flex items-center gap-6">
        <span class="font-semibold">Console Docker</span>
        <RouterLink to="/stacks" class="text-sm text-slate-600 hover:text-slate-900" active-class="font-medium text-slate-900">
          Stacks
        </RouterLink>
        <RouterLink to="/hosts" class="text-sm text-slate-600 hover:text-slate-900" active-class="font-medium text-slate-900">
          Hôtes
        </RouterLink>
        <RouterLink to="/backup" class="text-sm text-slate-600 hover:text-slate-900" active-class="font-medium text-slate-900">
          Sauvegarde Git
        </RouterLink>
        <RouterLink to="/settings" class="text-sm text-slate-600 hover:text-slate-900" active-class="font-medium text-slate-900">
          Paramètres
        </RouterLink>
      </div>
      <div class="flex items-center gap-3 text-sm text-slate-600">
        <span>{{ session.username }}</span>
        <button class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" @click="logout">
          Déconnexion
        </button>
      </div>
    </nav>
  </header>
  <div v-if="session.username && !session.hasRestorationKey" role="alert" class="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
    Aucune clé de restauration : les secrets ne peuvent pas être sauvegardés dans Git.
    <RouterLink to="/backup" class="underline">Générer la clé</RouterLink>
  </div>
  <main class="mx-auto max-w-5xl px-4 py-8">
    <RouterView />
  </main>
</template>
