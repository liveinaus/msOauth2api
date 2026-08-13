import { createRouter, createWebHistory } from "vue-router";
import AccountsView from "../views/AccountsView.vue";
import LoginView from "../views/LoginView.vue";
import MailView from "../views/MailView.vue";
import SettingsView from "../views/SettingsView.vue";
import TypesView from "../views/TypesView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/", name: "accounts", component: AccountsView },
    { path: "/mail/:email", name: "mail", component: MailView, props: true },
    { path: "/types", name: "types", component: TypesView },
    { path: "/settings", name: "settings", component: SettingsView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach((to) => {
  const isPublic = to.meta.public === true;
  const hasToken = Boolean(localStorage.getItem("token"));

  if (!isPublic && !hasToken) return "/login";
  if (isPublic && hasToken) return "/";
  return true;
});

export default router;
