import { createRouter, createWebHistory } from "vue-router";
import { useSession } from "./stores/session";
import HostsView from "./views/HostsView.vue";
import LoginView from "./views/LoginView.vue";
import SettingsView from "./views/SettingsView.vue";
import SetupView from "./views/SetupView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/hosts" },
    { path: "/setup", component: SetupView, meta: { public: true } },
    { path: "/login", component: LoginView, meta: { public: true } },
    { path: "/hosts", component: HostsView },
    { path: "/settings", component: SettingsView },
  ],
});

router.beforeEach(async (to) => {
  const session = useSession();
  await session.refresh();
  if (!session.initialized) return to.path === "/setup" ? true : "/setup";
  if (to.path === "/setup") return session.username ? "/hosts" : "/login";
  if (!session.username && !to.meta.public) return "/login";
  if (session.username && to.path === "/login") return "/hosts";
  return true;
});
