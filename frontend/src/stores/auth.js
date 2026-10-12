// Web sessions remain cookie-based; desktop identity is supplied by the Windows host.
import { defineStore } from 'pinia'
import { api, isDesktop } from '../lib/api.js'
import { DesktopError } from '../lib/desktopBridge.js'

/** @typedef {{ id: string, email: string, role: string, displayName?: string, authMode?: string, sid?: string }} User */

export const useAuthStore = defineStore('auth', {
  state: () => ({
    /** @type {User | null} */
    user: null,
    booted: false,
    loading: false,
    connectionError: null,
  }),
  getters: {
    isAuthed: (s) => !!s.user,
  },
  actions: {
    async bootstrap() {
      if (this.booted) {
        if (isDesktop() && this.connectionError) throw this.connectionError
        return
      }
      this.loading = true
      this.connectionError = null
      try {
        const res = await api('/me')
        if (isDesktop() && (!res?.user?.id || res.user.authMode !== 'windows' ||
            typeof res.user.email !== 'string' || typeof res.user.displayName !== 'string' ||
            typeof res.user.role !== 'string' || !res.user.role)) {
          throw new DesktopError('windows_identity_required', 'El host no ha proporcionado una identidad Windows válida.')
        }
        this.user = res.user || null
      } catch (error) {
        this.user = null
        if (isDesktop()) {
          this.connectionError = error
          throw error
        }
        // Web: an unavailable API is treated as logged out.
      } finally {
        this.booted = true
        this.loading = false
      }
    },
    async register() {
      throw new Error('Public registration is disabled.')
    },
    async login(email, password) {
      if (isDesktop()) throw new DesktopError('windows_auth', 'Desktop utiliza la identidad de Windows, no contraseñas.')
      this.loading = true
      try {
        await api('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        })
        this.booted = false
        await this.bootstrap()
      } finally {
        this.loading = false
      }
    },
    async logout() {
      if (isDesktop()) throw new DesktopError('windows_auth', 'La sesión Windows la gestiona el host desktop.')
      this.loading = true
      try {
        await api('/auth/logout', { method: 'POST' })
        this.user = null
      } finally {
        this.loading = false
      }
    },
  },
})
