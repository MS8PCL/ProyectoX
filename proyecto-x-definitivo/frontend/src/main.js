import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { router } from './router'
import { useAuthStore } from './stores/auth.js'
import App from './App.vue'

import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// Auth guard must run after Pinia is installed (avoid "no active Pinia").
router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia)
  const appStore = (await import('./stores/app.js')).useAppStore(pinia)

  await auth.bootstrap()

  // Public routes: login/register
  if (to.meta.public) {
    if (auth.isAuthed) return { name: 'home' }
    return true
  }

  // Everything else requires an authenticated session
  if (to.meta.requiresAuth && !auth.isAuthed) {
    return { name: 'login', query: { next: to.fullPath } }
  }

  // Ensure app state is ready
  await appStore.bootstrap()

  // Sync role from authenticated user.
  // Internal-only mode: admin/rrhh/it behave as "empresa" in the UI (RRHH tool).
  const internal = ['admin', 'rrhh', 'it'].includes(String(auth.user?.role || ''))
  const serverRole = internal ? 'empresa' : auth.user?.role === 'company' ? 'empresa' : 'candidato'
  if (appStore.state?.role && appStore.state.role !== serverRole) {
    appStore.state.role = serverRole
    await appStore._persist()
  }

  // Server-side onboarding gate (PocketBase source of truth)
  // Internal roles do NOT require onboarding profiles.
  if (!internal) {
    try {
      const { api } = await import('./lib/api.js')
      const status = await api('/onboarding/status')
      if (!status?.complete && to.name !== 'perfil') {
        return { name: 'perfil', query: { onboarding: '1', next: to.fullPath } }
      }
    } catch {
      // If backend is down, fallback to local heuristic.
      if (to.name !== 'perfil' && !appStore.isProfileComplete(appStore.role)) {
        return { name: 'perfil', query: { onboarding: '1', next: to.fullPath } }
      }
    }
  }

  return true
})

app.mount('#app')
