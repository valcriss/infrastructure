<script setup lang="ts">
import { useRoute } from "vue-router";
import { useUi } from "../stores/ui";
import { ADMIN_NAV, MAIN_NAV, type NavItem } from "./nav";

const ui = useUi();
const route = useRoute();
const groups = [MAIN_NAV, ADMIN_NAV];

const active = (item: NavItem): boolean =>
  route.path === item.to || (item.match ?? []).some((p) => route.path === p || route.path.startsWith(p + "/"));
</script>

<template>
  <!-- Fond du tiroir sur petit écran -->
  <div v-if="ui.drawerOpen" class="fixed inset-0 z-30 bg-black/40 lg:hidden" @click="ui.drawerOpen = false"></div>

  <aside
    :class="[
      'fixed bottom-0 left-0 top-14 z-40 flex flex-col border-r border-slate-200 bg-white transition-all duration-200',
      ui.collapsed ? 'lg:w-16' : 'lg:w-60',
      ui.drawerOpen ? 'w-60 translate-x-0' : 'w-60 -translate-x-full lg:translate-x-0',
    ]"
    aria-label="Navigation principale"
  >
    <nav class="flex-1 space-y-1 overflow-y-auto p-2">
      <template v-for="(group, i) in groups" :key="i">
        <hr v-if="i > 0" class="my-2 border-slate-200" />
        <RouterLink
          v-for="item in group"
          :key="item.to"
          :to="item.to"
          :title="ui.collapsed ? item.label : undefined"
          :aria-current="active(item) ? 'page' : undefined"
          :class="[
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
            active(item) ? 'bg-blue-600 font-medium text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
          ]"
          @click="ui.drawerOpen = false"
        >
          <FaIcon :icon="['fas', item.icon]" fixed-width class="shrink-0" />
          <span :class="ui.collapsed ? 'lg:sr-only' : ''">{{ item.label }}</span>
        </RouterLink>
      </template>
    </nav>
    <button
      class="hidden items-center gap-3 border-t border-slate-200 px-5 py-3 text-sm text-slate-500 hover:text-slate-900 lg:flex"
      :aria-label="ui.collapsed ? 'Déplier le menu' : 'Replier le menu'"
      @click="ui.toggleCollapsed()"
    >
      <FaIcon :icon="['fas', ui.collapsed ? 'chevron-right' : 'chevron-left']" fixed-width />
      <span v-if="!ui.collapsed">Replier</span>
    </button>
  </aside>
</template>
