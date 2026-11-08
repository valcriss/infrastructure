import { createRouter, createWebHistory } from "vue-router";
import { useSession } from "./stores/session";
import AccountView from "./views/AccountView.vue";
import DashboardView from "./views/DashboardView.vue";
import HostsView from "./views/HostsView.vue";
import ImagesView from "./views/ImagesView.vue";
import LoginView from "./views/LoginView.vue";
import SettingsView from "./views/SettingsView.vue";
import SetupView from "./views/SetupView.vue";
import ObservedProjectView from "./views/ObservedProjectView.vue";
import StackNewView from "./views/StackNewView.vue";
import StackView from "./views/StackView.vue";
import StacksView from "./views/StacksView.vue";
import StatusView from "./views/StatusView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/dashboard", component: DashboardView },
    { path: "/setup", component: SetupView, meta: { public: true } },
    { path: "/login", component: LoginView, meta: { public: true } },
    { path: "/hosts", component: HostsView },
    { path: "/images", component: ImagesView },
    { path: "/stacks", component: StacksView },
    { path: "/stacks/new", component: StackNewView },
    { path: "/stacks/:id", component: StackView },
    { path: "/backup", redirect: "/settings?tab=git" },
    { path: "/account", component: AccountView },
    { path: "/hosts/:hostId/projects/:name", component: ObservedProjectView },
    { path: "/settings", component: SettingsView },
    { path: "/statut", component: StatusView },
  ],
});

router.beforeEach(async (to) => {
  const session = useSession();
  await session.refresh();
  if (!session.initialized) return to.path === "/setup" ? true : "/setup";
  if (to.path === "/setup") return session.username ? "/dashboard" : "/login";
  if (!session.username && !to.meta.public) return "/login";
  if (session.username && to.path === "/login") return "/dashboard";
  // Mot de passe provisoire : seule la page « Mon compte » est accessible tant qu'il n'est pas changé.
  if (session.info?.mustChangePassword && to.path !== "/account") return "/account";
  return true;
});
