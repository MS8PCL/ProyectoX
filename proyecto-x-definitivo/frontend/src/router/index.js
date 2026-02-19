import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../pages/LoginPage.vue'),
    meta: { public: true },
  },
  {
    path: '/apply/:token',
    name: 'applyPublic',
    component: () => import('../pages/ApplyPublicPage.vue'),
    meta: { public: true },
  },
  // /register removed (internal-only tool)
  { path: '/register', name: 'register_disabled', redirect: '/login' },
  // Back-compat internal URL
  { path: '/interno/seleccion', redirect: '/candidatos' },

  {
    path: '/',
    component: () => import('../layouts/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', name: 'home', component: () => import('../pages/HomePage.vue') },
      { path: 'buscar', name: 'buscar', component: () => import('../pages/SearchPage.vue') },
      { path: 'publicar', name: 'publicar', component: () => import('../pages/PublishPage.vue') },
      { path: 'candidaturas', name: 'candidaturas', component: () => import('../pages/ApplicationsPage.vue') },
      { path: 'candidatos', name: 'procesoServer', component: () => import('../pages/PipelineServerPage.vue'), alias: ['pipeline', 'proceso-seleccion', 'proceso-server'] },
      { path: 'perfil', name: 'perfil', component: () => import('../pages/ProfilePage.vue') },
      { path: 'candidatos/:candidateId', name: 'candidateProfile', component: () => import('../pages/CandidateProfilePage.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', name: 'notfound', component: () => import('../pages/NotFoundPage.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
