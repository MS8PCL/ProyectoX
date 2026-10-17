// If served behind Caddy (http://localhost:8787), API lives at same origin under /api.
// You can override with VITE_API_URL.
import { isDesktop } from './desktopBridge.js'
import { desktopApi } from './desktopApi.js'
export { desktopRequest, isDesktop } from './desktopBridge.js'
export { getDesktopState } from './desktopApi.js'

const API_URL = import.meta.env?.VITE_API_URL ?? '/api'

/**
 * @template T
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<T>}
 */
export async function api(path, init) {
  if (isDesktop()) {
    const result = await desktopApi(path, init)
    if (path === '/notifications' && String(init?.method || 'GET').toUpperCase() === 'GET' && Array.isArray(result?.items)) return result.items
    return result
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'include',
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text || res.statusText}`)
  }

  return await res.json()
}

/**
 * Reads every page of a paginated list ({items, totalPages}). The hosts default to
 * 20 items per page, so a bare GET silently drops all older records.
 * @param {string} path
 * @param {number} [perPage]
 * @returns {Promise<any[]>}
 */
export async function apiAllPages(path, perPage = 200) {
  const items = []
  const separator = path.includes('?') ? '&' : '?'
  for (let page = 1; ; page++) {
    const res = await api(`${path}${separator}page=${page}&perPage=${perPage}`)
    const raw = Array.isArray(res) ? res : res?.items
    if (!Array.isArray(raw)) throw new Error('Respuesta paginada inválida')
    items.push(...raw)
    const totalPages = Number(res?.totalPages)
    if (Array.isArray(res) || !Number.isFinite(totalPages) || page >= totalPages || raw.length === 0) return items
  }
}

/**
 * Multipart helper (FormData). Does not set content-type.
 * @template T
 * @param {string} path
 * @param {FormData} form
 * @returns {Promise<T>}
 */
export async function apiForm(path, form) {
  if (isDesktop()) return desktopApi(path, { method: 'POST', body: form })
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    body: form,
    credentials: 'include',
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text || res.statusText}`)
  }

  return await res.json()
}
