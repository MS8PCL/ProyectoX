// (Deprecated) Auth store kept for later online mode.
// For now, Proyecto X funciona offline con localStorage.
import { defineStore } from 'pinia'
import { api } from '../lib/api.js'

/** @typedef {{ id: string, email: string, sid?: string }} User */

export const useAuthStore = defineStore('auth', {
  state: () => ({
    /** @type {User | null} */
    user: null,
    booted: false,
    loading: false,
  }),
  getters: {
    isAuthed: (s) => !!s.user,
  },
  actions: {
    async bootstrap() {
      if (this.booted) return
      this.loading = true
      try {
        const res = await api('/me')
        this.user = res.user || null
      } catch {
        // Offline/dev fallback: if API is not reachable (or returns HTML), treat as logged out.
        this.user = null
      } finally {
        this.booted = true
        this.loading = false
      }
    },
    async register() {
      throw new Error('Public registration is disabled.')
    },
    async login(email, password) {
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
