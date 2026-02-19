<template>
  <div class="app" @keydown="onKeydown">
    <aside class="nav" aria-label="Navegación lateral">
      <div class="brand">
        <div class="mark" aria-hidden="true" />
        <div class="title">
          <div class="name">Proyecto X</div>
          <div class="sub">panel</div>
        </div>
      </div>

      <div class="switches">
        <button class="btn" @click="app.toggleTheme()">
          Tema: <span class="muted">{{ themeLabel }}</span>
        </button>
        <button class="btn" disabled title="El rol viene del servidor">
          Rol: <span class="muted">{{ roleLabel }}</span>
        </button>
      </div>

      <nav class="links" aria-label="Secciones">
        <RouterLink class="link" to="/">Inicio <span class="muted">[1]</span></RouterLink>
        <RouterLink class="link" to="/buscar">Buscar <span class="muted">[2]</span></RouterLink>
        <RouterLink v-if="app.role === 'empresa'" class="link" to="/publicar">Publicar <span class="muted">[3]</span></RouterLink>
        <RouterLink class="link" to="/candidatos">Proceso de Selección</RouterLink>
        <RouterLink class="link" to="/perfil">Perfil <span class="muted">[4]</span></RouterLink>
      </nav>

      <div class="foot card">
        <div class="row" style="justify-content: space-between">
          <span class="muted">Cuenta</span>
          <span class="kbd" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis">
            {{ auth.user?.email || '—' }}
          </span>
        </div>

        <button class="btn" style="margin-top: 10px" @click="onLogout">Cerrar sesión</button>
      </div>
    </aside>

    <main class="main">
      <header class="top">
        <div class="crumbs">
          <span class="muted">Ruta</span>
          <span>{{ $route.path }}</span>
        </div>
        <span class="favLink" aria-disabled="true">
          <span class="muted">Listas</span>
          <span class="kbd">—</span>
        </span>
      </header>

      <section class="content">
        <RouterView />
      </section>

      <div v-if="app.drawer.open" class="drawerBackdrop" @click="app.closeDrawer()" />

      <aside v-if="app.drawer.open" class="drawer" aria-label="Detalle anuncio">
        <ListingDetail :id="app.drawer.listingId" @close="app.closeDrawer()" />
      </aside>

      <div v-if="app.toast" class="toast" role="status" @click="app.clearToast()">
        <span class="dot" :data-kind="app.toast.kind" />
        <span>{{ app.toast.text }}</span>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { useAuthStore } from '../stores/auth.js'
import ListingDetail from '../components/ListingDetail.vue'

// themeLabel is declared after app

const router = useRouter()
const app = useAppStore()
const auth = useAuthStore()

const themeLabel = computed(() => (app.theme === 'terminal' ? 'Oscuro' : 'Claro'))
const roleLabel = computed(() => (app.role === 'empresa' ? 'Empresa' : 'Candidato'))

onMounted(async () => {
  // Router guard enforces auth + onboarding; we just bootstrap.
  await auth.bootstrap()
  await app.bootstrap()
})

async function onLogout() {
  await auth.logout()
  router.replace('/login')
}

// onToggleRole removed: role is server-driven

function onKeydown(e) {
  if (e.key === 'Escape') {
    app.closeDrawer()
  }

  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return

  if (e.key === '1') return (window.location.href = '/')
  if (e.key === '2') return (window.location.href = '/buscar')
  if (e.key === '3') return (window.location.href = '/publicar')
  if (e.key === '4') return (window.location.href = '/perfil')
}
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 300px 1fr;
}

.nav {
  border-right: 1px solid var(--line);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.brand {
  display: flex;
  gap: 12px;
  align-items: center;
}

.mark {
  width: 12px;
  height: 12px;
  background: var(--ink);
}

.title .name {
  font-weight: 650;
}

.title .sub {
  font-size: 12px;
  color: var(--muted);
}

.switches {
  display: grid;
  gap: 8px;
}

.links {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link {
  padding: 10px 10px;
  border: 1px solid var(--line);
  text-decoration: none;
  color: inherit;
}

.link.router-link-active {
  border-color: var(--line2);
  background: var(--card2);
}

.foot {
  margin-top: auto;
}

.main {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}

.favLink {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: inherit;
}

.crumbs {
  font-size: 12px;
  display: flex;
  gap: 10px;
}

.content {
  padding: 20px;
}

.drawerBackdrop {
  position: fixed;
  inset: 0;
  background: var(--overlay);
}

.drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: min(560px, 96vw);
  border-left: 1px solid var(--line);
  background: var(--bg);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  border: 1px solid var(--line);
  background: var(--card);
  padding: 10px 12px;
  display: flex;
  gap: 10px;
  align-items: center;
  cursor: pointer;
}

.dot {
  width: 8px;
  height: 8px;
  border: 1px solid var(--line2);
  background: var(--card2);
}

.dot[data-kind='ok'] {
  border-color: color-mix(in oklab, var(--accent) 55%, var(--line2));
  background: color-mix(in oklab, var(--accent) 15%, var(--card2));
}

.dot[data-kind='info'] {
  border-color: color-mix(in oklab, var(--accent2) 55%, var(--line2));
  background: color-mix(in oklab, var(--accent2) 15%, var(--card2));
}

@media (max-width: 900px) {
  .app {
    grid-template-columns: 1fr;
  }

  .nav {
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
}
</style>
