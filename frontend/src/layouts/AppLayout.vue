<template>
  <div class="app-layout" @keydown="onKeydown">
    <!-- Sidebar -->
    <aside class="sidebar">
      <!-- Brand -->
      <div class="brand">
        <div class="brand-icon">
          <LayoutGrid :size="20" />
        </div>
        <div class="brand-text">
          <div class="brand-name">{{ t('app.title') }}</div>
          <div class="brand-sub">{{ t('app.subtitle') }}</div>
        </div>
      </div>

      <!-- Quick actions -->
      <div class="sidebar-actions">
        <button class="btn btn-sm btn-ghost w-full" @click="app.toggleTheme()">
          <Sun :size="14" v-if="app.theme === 'terminal'" />
          <Moon :size="14" v-else />
          <span class="text-sm">{{ themeLabel }}</span>
        </button>
        <!-- Language toggle -->
        <div class="lang-toggle">
          <button
            class="btn btn-sm lang-btn"
            :class="{ 'lang-btn--active': locale === 'es' }"
            @click="setLocale('es')"
          >ES</button>
          <button
            class="btn btn-sm lang-btn"
            :class="{ 'lang-btn--active': locale === 'en' }"
            @click="setLocale('en')"
          >EN</button>
        </div>
        <div class="badge badge-neutral text-xs w-full" style="justify-content: center">
          {{ roleLabel }}
        </div>
      </div>

      <!-- Navigation -->
      <nav class="nav-links">
        <RouterLink class="nav-item" to="/">
          <Home :size="16" />
          <span>{{ t('nav.home') }}</span>
          <kbd class="kbd">1</kbd>
        </RouterLink>
        <RouterLink class="nav-item" to="/buscar">
          <Search :size="16" />
          <span>{{ t('nav.search') }}</span>
          <kbd class="kbd">2</kbd>
        </RouterLink>
        <RouterLink class="nav-item" to="/publicar">
          <PlusCircle :size="16" />
          <span>{{ t('nav.publish') }}</span>
          <kbd class="kbd">3</kbd>
        </RouterLink>
        <RouterLink class="nav-item" to="/candidatos">
          <Users :size="16" />
          <span>{{ t('nav.pipeline') }}</span>
        </RouterLink>

        <div class="divider" style="margin: 8px 0" />

        <RouterLink class="nav-item" to="/enterprise/dashboard">
          <BarChart3 :size="16" />
          <span>{{ t('nav.metrics') }}</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/enterprise/outbox">
          <ClipboardList :size="16" />
          <span>{{ t('nav.pendingHires') }}</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/enterprise/rbac">
          <Shield :size="16" />
          <span>{{ t('nav.permissions') }}</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/enterprise/hire-tools">
          <Wrench :size="16" />
          <span>{{ t('nav.hireIt') }}</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/enterprise/audit">
          <ScrollText :size="16" />
          <span>{{ t('nav.audit') }}</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/enterprise/reports">
          <FileSpreadsheet :size="16" />
          <span>{{ t('nav.reports') }}</span>
        </RouterLink>
      </nav>

      <!-- Footer -->
      <div class="sidebar-footer">
        <div class="card card-sm">
          <div class="row justify-between items-center">
            <div class="avatar avatar-sm">{{ avatarInitial }}</div>
            <div class="text-sm truncate" style="flex: 1; margin: 0 10px">{{ auth.user?.email || auth.user?.displayName || '—' }}</div>
          </div>
          <button class="btn btn-ghost btn-sm w-full mt-8" @click="onLogout">
            <LogOut :size="14" />
            <span>{{ desktop ? 'Cerrar aplicación' : t('nav.logout') }}</span>
          </button>
        </div>
      </div>
    </aside>

    <!-- Main -->
    <main class="main-area">
      <!-- Topbar -->
      <header class="topbar">
        <div class="row items-center gap-12">
          <span class="text-sm faint">Pharmamar</span>
          <span class="text-sm font-mono">{{ $route.path }}</span>
        </div>
        <div class="row items-center gap-16">
          <!-- Notification bell -->
          <div class="notification-bell" ref="bellRef">
            <button class="btn btn-icon btn-ghost" @click="toggleNotifications">
              <component :is="notifications.unreadCount ? BellDot : Bell" :size="18" />
            </button>
            <span v-if="notifications.unreadCount" class="notification-count">{{ notifications.unreadCount }}</span>

            <!-- Notification panel -->
            <div v-if="notifOpen" class="notification-panel animate-scaleIn">
              <div class="row justify-between items-center" style="padding: 12px 16px; border-bottom: 1px solid var(--color-border)">
                <span class="font-semibold text-sm">{{ t('notifications.title') }}</span>
                <button class="btn btn-ghost btn-sm" @click="notifications.markAllRead()">{{ t('notifications.clear') }}</button>
              </div>
              <div style="max-height: 380px; overflow-y: auto">
                <button
                  v-for="n in notifications.recent"
                  :key="n.id"
                  class="notification-item"
                  :class="{ 'notification-item--unread': !n.read }"
                  @click="onNotifClick(n)"
                >
                  <div class="notification-icon" :data-type="n.type">
                    <component :is="notifIcon(n.type)" :size="16" />
                  </div>
                  <div style="flex: 1; min-width: 0">
                    <div class="text-sm font-semibold">{{ n.title }}</div>
                    <div class="text-xs muted mt-2">{{ n.body }}</div>
                    <div class="text-xs faint mt-4">{{ timeAgo(n.createdAt) }}</div>
                  </div>
                  <div v-if="!n.read" class="notification-dot" />
                </button>
                <div v-if="!notifications.recent.length" class="notification-empty text-sm muted text-center" style="padding: 32px">
                  {{ t('notifications.empty') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <!-- Content -->
      <section class="content">
        <RouterView v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </RouterView>
      </section>

      <!-- Drawer -->
      <div v-if="app.drawer.open" class="drawer-backdrop" @click="app.closeDrawer()" />
      <aside v-if="app.drawer.open" class="drawer animate-slideRight">
        <div class="drawer-header">
          <h3 class="text-lg font-semibold">{{ t('search.detail') }}</h3>
          <button class="btn btn-icon btn-ghost" @click="app.closeDrawer()">
            <X :size="18" />
          </button>
        </div>
        <div class="drawer-body">
          <ListingDetail :id="app.drawer.listingId" @close="app.closeDrawer()" />
        </div>
      </aside>

      <!-- Toast -->
      <transition name="toast">
        <div v-if="app.toast" class="toast" role="status" @click="app.clearToast()">
          <span class="toast-dot" :data-kind="app.toast.kind" />
          <span class="text-sm">{{ app.toast.text }}</span>
        </div>
      </transition>

      <!-- Onboarding Wizard -->
      <OnboardingWizard v-if="showOnboarding" @done="showOnboarding = false" />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { useAuthStore } from '../stores/auth.js'
import { useNotificationsStore } from '../stores/notifications.js'
import { t, setLocale, currentLocale } from '../lib/i18n.js'
import ListingDetail from '../components/ListingDetail.vue'
import OnboardingWizard from '../components/OnboardingWizard.vue'
import {
  LayoutGrid, Home, Search, PlusCircle, Users, User,
  BarChart3, Shield, Wrench, ScrollText, FileSpreadsheet, ClipboardList,
  Sun, Moon, LogOut, X, Bell, BellDot,
  Info, AlertTriangle, ArrowRightLeft, Megaphone, Monitor
} from 'lucide-vue-next'

const desktop = !!window.chrome?.webview
const router = useRouter()
const app = useAppStore()
const auth = useAuthStore()
const notifications = useNotificationsStore()

const themeLabel = computed(() => app.theme === 'terminal' ? t('nav.dark') : t('nav.light'))
const roleLabel = computed(() => app.role === 'empresa' ? t('nav.rrhh') : 'N/A')
const avatarInitial = computed(() => (auth.user?.email?.[0] || 'P').toUpperCase())
const showOnboarding = ref(false)
const locale = computed(() => currentLocale())

const notifOpen = ref(false)
const bellRef = ref(null)

onMounted(async () => {
  await auth.bootstrap()
  await app.bootstrap()
  notifications.startPolling()

  // Show onboarding if not completed
  if (localStorage.getItem('px_onboarding') !== 'v2') {
    showOnboarding.value = true
  }
})

onUnmounted(() => {
  notifications.stopPolling()
})

// Close notification panel on outside click
watch(notifOpen, (val) => {
  if (val) {
    const handler = (e) => {
      if (bellRef.value && !bellRef.value.contains(e.target)) {
        notifOpen.value = false
        document.removeEventListener('click', handler)
      }
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
  }
})

function toggleNotifications() {
  notifOpen.value = !notifOpen.value
}

function onNotifClick(n) {
  notifications.markRead(n.id)
  notifOpen.value = false
  if (n.link) router.push(n.link)
}

function notifIcon(type) {
  const map = { info: Info, warning: AlertTriangle, move: ArrowRightLeft, publish: Megaphone, it: Monitor }
  return map[type] || Info
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return t('notifications.now')
  if (sec < 3600) return t('notifications.minAgo', { n: Math.floor(sec / 60) })
  if (sec < 86400) return t('notifications.hourAgo', { n: Math.floor(sec / 3600) })
  return t('notifications.dayAgo', { n: Math.floor(sec / 86400) })
}

async function onLogout() {
  if (desktop) {
    const { desktopRequest } = await import('../lib/api.js')
    await desktopRequest('closeApplication', {})
    return
  }
  await auth.logout()
  router.replace('/login')
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    app.closeDrawer()
    notifOpen.value = false
  }
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
  if (e.key === '1') { router.push('/'); return }
  if (e.key === '2') { router.push('/buscar'); return }
  if (e.key === '3') { router.push('/publicar'); return }
}
</script>

<style scoped>
/* === Sidebar === */
.sidebar { display: flex; flex-direction: column; padding: 20px 16px; gap: 16px; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 12px; padding: 4px 0 20px 0; border-bottom: 1px solid var(--color-border); }
.brand-icon { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, var(--color-accent), var(--color-accent-secondary)); display: flex; align-items: center; justify-content: center; color: #fff; }
.brand-name { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.brand-sub { font-size: 11px; color: var(--color-muted); margin-top: 2px; }
.sidebar-actions { display: flex; flex-direction: column; gap: 8px; }

/* Language toggle */
.lang-toggle { display: flex; gap: 4px; }
.lang-btn {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-muted);
  transition: all 0.15s ease;
  justify-content: center;
}
.lang-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}
.lang-btn--active {
  color: var(--color-text);
  background: var(--color-surface-active);
  border-color: var(--color-accent);
  font-weight: 700;
}

.nav-links { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; color: var(--color-muted); text-decoration: none; font-size: 14px; transition: all 0.15s ease; position: relative; }
.nav-item:hover { color: var(--color-text); background: var(--color-surface-hover); }
.nav-item.router-link-active { color: var(--color-text); background: var(--color-surface-active); font-weight: 500; }
.nav-item.router-link-active::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: linear-gradient(180deg, var(--color-accent), var(--color-accent-secondary)); }
.nav-item .kbd { margin-left: auto; }
.sidebar-footer { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--color-border); }

/* Main */
.main-area { display: flex; flex-direction: column; min-height: 100vh; overflow: hidden; }
.topbar { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 24px; background: var(--color-topbar-bg); border-bottom: 1px solid var(--color-border); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); flex-shrink: 0; z-index: 10; }
.content { flex: 1; padding: 24px; overflow-y: auto; min-height: 0; }

/* Drawer */
.drawer-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: 50; }
.drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(520px, 94vw); background: var(--color-surface); border-left: 1px solid var(--color-border); z-index: 60; display: flex; flex-direction: column; }
.drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--color-border); }
.drawer-body { flex: 1; overflow-y: auto; padding: 20px 24px; }

/* Toast */
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--color-surface-glass); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--color-border); border-radius: 12px; padding: 12px 20px; display: flex; align-items: center; gap: 10px; cursor: pointer; z-index: 100; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3); }
.toast-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.toast-dot[data-kind='ok'] { background: var(--color-success); box-shadow: 0 0 8px var(--color-success); }
.toast-dot[data-kind='info'] { background: var(--color-info); box-shadow: 0 0 8px var(--color-info); }
.toast-dot[data-kind='error'] { background: var(--color-danger); box-shadow: 0 0 8px var(--color-danger); }

/* Transitions */
.page-enter-active, .page-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.page-enter-from { opacity: 0; transform: translateY(8px); }
.page-leave-to { opacity: 0; transform: translateY(-8px); }
.toast-enter-active { transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(12px) scale(0.95); }
.toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(12px) scale(0.95); }

@media (max-width: 768px) {
  .sidebar { display: none; }
  .content { padding: 16px; }
  .topbar { padding: 0 16px; }
  .drawer { width: 100vw; }
}
</style>
