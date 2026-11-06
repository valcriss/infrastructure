import { createRouter, createWebHistory } from "vue-router";
import { useSession } from "./stores/session";
import HostsView from "./views/HostsView.vue";
import LoginView from "./views/LoginView.vue";
import SettingsView from "./views/SettingsView.vue";
import SetupView from "./views/SetupView.vue";
import StackNewView from "./views/StackNewView.vue";
import StackView from "./views/StackView.vue";
import StacksView from "./views/StacksView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/stacks" },
    { path: "/setup", component: SetupView, meta: { public: true } },
    { path: "/login", component: LoginView, meta: { public: true } },
    { path: "/hosts", component: HostsView },
    { path: "/stacks", component: StacksView },
    { path: "/stacks/new", component: StackNewView },
    { path: "/stacks/:id", component: StackView },
    { path: "/settings", component: SettingsView },
  ],
});

router.beforeEach(async (to) => {
  const session = useSession();
  await session.refresh();
  if (!session.initialized) return to.path === "/setup" ? true : "/setup";
  if (to.path === "/setup") return session.username ? "/stacks" : "/login";
  if (!session.username && !to.meta.public) return "/login";
  if (session.username && to.path === "/login") return "/stacks";
  return true;
});
