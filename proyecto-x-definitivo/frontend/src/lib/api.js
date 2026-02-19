// If served behind Caddy (http://localhost:8787), API lives at same origin under /api.
// You can override with VITE_API_URL.
const API_URL = import.meta.env.VITE_API_URL ?? '/api'

/**
 * @template T
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<T>}
 */
export async function api(path, init) {
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
 * Multipart helper (FormData). Does not set content-type.
 * @template T
 * @param {string} path
 * @param {FormData} form
 * @returns {Promise<T>}
 */
export async function apiForm(path, form) {
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
