import { defineStore } from 'pinia'
import { api } from '../lib/api.js'
import { isDesktopMode } from '../lib/storage.js'

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** Seed data demo: 5 notificaciones de ejemplo */
function seedNotifications() {
  const now = Date.now()
  const min = (m) => new Date(now - m * 60 * 1000).toISOString()
  const hr = (h) => new Date(now - h * 60 * 60 * 1000).toISOString()
  return [
    {
      id: uid(),
      type: 'move',
      title: 'Candidato movido',
      body: 'María González pasó a etapa de Entrevista Técnica',
      read: false,
      createdAt: min(2),
      link: '/candidatos',
    },
    {
      id: uid(),
      type: 'publish',
      title: 'Oferta publicada',
      body: 'Se publicó "Desarrollador Full Stack Senior"',
      read: false,
      createdAt: min(15),
      link: '/buscar',
    },
    {
      id: uid(),
      type: 'it',
      title: 'Alta IT completada',
      body: 'Se configuró el entorno para Juan Pérez — equipo listo',
      read: true,
      createdAt: hr(1),
      link: null,
    },
    {
      id: uid(),
      type: 'info',
      title: 'Nueva postulación',
      body: 'Carlos Ruiz aplicó a "DevOps Engineer"',
      read: true,
      createdAt: hr(3),
      link: '/candidaturas',
    },
    {
      id: uid(),
      type: 'warning',
      title: 'Recordatorio',
      body: 'La oferta "UX Designer" vence en 2 días',
      read: true,
      createdAt: hr(24),
      link: '/buscar',
    },
  ]
}

export const useNotificationsStore = defineStore('notifications', {
  state: () => ({
    /** @type {Array<{ id: string, type: string, title: string, body: string, read: boolean, createdAt: string, link: string | null }>} */
    items: isDesktopMode() ? [] : seedNotifications(),
    _timer: null,
  }),

  getters: {
    unreadCount: (s) => s.items.filter((n) => !n.read).length,

    recent: (s) => s.items.slice(0, 5),
  },

  actions: {
    /** Agrega una notificación y la marca como no leída */
    add(n) {
      this.items.unshift({
        id: n.id || uid(),
        type: n.type || 'info',
        title: n.title || '',
        body: n.body || '',
        read: false,
        createdAt: n.createdAt || new Date().toISOString(),
        link: n.link || null,
      })
    },

    /** Marca una notificación como leída */
    markRead(id) {
      const item = this.items.find((n) => n.id === id)
      if (item) item.read = true
    },

    /** Marca todas las notificaciones como leídas */
    markAllRead() {
      this.items.forEach((n) => {
        n.read = true
      })
    },

    /** Polling: simula fetch del endpoint GET /notifications cada 30s */
    async fetchFromServer() {
      try {
        const data = await api('/notifications')
        if (Array.isArray(data)) {
          // Mergea notificaciones nuevas con las existentes
          const existingIds = new Set(this.items.map((n) => n.id))
          for (const n of data) {
            if (!existingIds.has(n.id)) {
              this.add(n)
            }
          }
        }
      } catch {
        // Silencioso: endpoint simulado, esperable que falle hasta implementar backend
      }
    },

    startPolling() {
      this.stopPolling()
      this._timer = setInterval(() => this.fetchFromServer(), 30_000)
    },

    stopPolling() {
      if (this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
    },
  },
})
