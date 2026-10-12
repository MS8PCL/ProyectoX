import { createRouter, createWebHistory, createWebHashHistory } from "vue-router";
import { isDesktop } from "../lib/desktopBridge.js";

const routes = [
  {
    path: "/login",
    name: "login",
    component: () => import("../pages/LoginPage.vue"),
    meta: { public: true },
  },
  {
    path: "/apply/:token",
    name: "applyPublic",
    component: () => import("../pages/ApplyPublicPage.vue"),
    meta: { public: true },
  },
  // /register removed (internal-only tool)
  { path: "/register", name: "register_disabled", redirect: "/login" },
  // Back-compat internal URL (redirects to child route within AppLayout)
  { path: "/interno/seleccion", redirect: { name: "procesoServer" } },

  {
    path: "/",
    component: () => import("../layouts/AppLayout.vue"),
    meta: { requiresAuth: true },
    children: [
      {
        path: "",
        name: "home",
        component: () => import("../pages/HomePage.vue"),
      },
      {
        path: "buscar",
        name: "buscar",
        component: () => import("../pages/SearchPage.vue"),
      },
      {
        path: "publicar",
        name: "publicar",
        component: () => import("../pages/PublishPage.vue"),
      },
      {
        path: "candidaturas",
        name: "candidaturas",
        component: () => import("../pages/ApplicationsPage.vue"),
      },
      {
        path: "candidatos",
        name: "procesoServer",
        component: () => import("../pages/PipelineServerPage.vue"),
        alias: ["pipeline", "proceso-seleccion", "proceso-server"],
      },
      {
        path: "perfil",
        name: "perfil",
        component: () => import("../pages/ProfilePage.vue"),
      },
      {
        path: "favoritos",
        name: "favoritos",
        component: () => import("../pages/FavoritesPage.vue"),
      },

      // Enterprise HR→IT (MVP)
      {
        path: "enterprise/dashboard",
        name: "entDash",
        component: () => import("../pages/EnterpriseDashboardPage.vue"),
      },
      {
        path: "enterprise/catalog",
        name: "entCatalog",
        component: () => import("../pages/EnterpriseCatalogPage.vue"),
      },
      {
        path: "enterprise/rbac",
        name: "entRbac",
        component: () => import("../pages/EnterpriseRbacPage.vue"),
      },
      {
        path: "enterprise/outbox",
        name: "entOutbox",
        component: () => import("../pages/EnterpriseOutboxPage.vue"),
        alias: ["/interno/altas"],
      },
      {
        path: "enterprise/hire-tools",
        name: "entHireTools",
        component: () => import("../pages/EnterpriseHireToolsPage.vue"),
      },
      {
        path: "enterprise/reports",
        name: "entReports",
        component: () => import("../pages/ReportsPage.vue"),
      },
      {
        path: "enterprise/audit",
        name: "entAudit",
        component: () => import("../pages/AuditLogPage.vue"),
      },
      // Listas: desactivado en modo no-demo (pendiente server-side)
      {
        path: "candidatos/:candidateId",
        name: "candidateProfile",
        component: () => import("../pages/CandidateProfilePage.vue"),
      },
      // (hidden) import/planes/datos during UI cleanup
    ],
  },
  {
    path: "/:pathMatch(.*)*",
    name: "notfound",
    component: () => import("../pages/NotFoundPage.vue"),
  },
];

export const router = createRouter({
  history: isDesktop() ? createWebHashHistory() : createWebHistory(),
  routes,
});
