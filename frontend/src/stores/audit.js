import { defineStore } from 'pinia'
import { isDesktopMode } from '../lib/storage.js'

function uid(prefix = 'audit') {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`
}

function seedAuditLog() {
  const actions = [
    { action: 'movió candidato', icon: 'ArrowRightLeft' },
    { action: 'publicó oferta', icon: 'FilePlus' },
    { action: 'eliminó aplicación', icon: 'Trash2' },
    { action: 'completó alta IT', icon: 'UserCheck' },
    { action: 'modificó perfil', icon: 'UserPen' },
    { action: 'inició sesión', icon: 'LogIn' },
    { action: 'exportó ZIP', icon: 'Download' },
    { action: 'importó candidatos', icon: 'Upload' },
    { action: 'generó link de aplicación', icon: 'Link' },
    { action: 'cambió etapa', icon: 'GripHorizontal' },
    { action: 'creó lista de talento', icon: 'ListPlus' },
    { action: 'envió notificación', icon: 'Bell' },
  ]

  const entities = [
    'candidatura',
    'oferta',
    'aplicación',
    'perfil',
    'usuario',
    'documento',
    'token',
    'lista',
    'outbox',
  ]

  const users = ['admin@proyectox.com', 'rrhh@empresa.com', 'it@empresa.com', 'manager@empresa.com', 'reclutador@empresa.com']

  const details = [
    'Candidato Juan Pérez → etapa Entrevista',
    'Oferta "Senior Frontend Dev" publicada',
    'Aplicación #APP-042 eliminada',
    'Alta IT completada: María García',
    'Perfil actualizado: skills + ubicación',
    'Sesión iniciada desde 192.168.1.100',
    'Export ZIP: candidatura #APP-038',
    'Import masivo: 5 candidatos en listing #LST-007',
    'Link de aplicación generado: expira 30 días',
    'Etapa cambiada: Revisión → Oferta',
    'Lista "Backend Engineers" creada',
    'Notificación enviada a candidato #CND-015',
  ]

  const entries = []

  // Generate 20 entries with decreasing timestamps
  const now = Date.now()
  for (let i = 0; i < 20; i++) {
    const idx = i % actions.length
    const timestamp = new Date(now - i * 3600000 * (1 + (i % 7))) // spread over hours

    entries.push({
      id: uid(),
      timestamp: timestamp.toISOString(),
      user: users[i % users.length],
      action: actions[idx].action,
      icon: actions[idx].icon,
      entity: entities[i % entities.length],
      details: details[idx],
    })
  }

  // Sort by timestamp descending
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

  return entries
}

export const useAuditStore = defineStore('audit', {
  state: () => ({
    entries: isDesktopMode() ? [] : seedAuditLog(),
  }),
  getters: {
    allEntries: (s) => s.entries,
    uniqueActions: (s) => {
      const set = new Set(s.entries.map((e) => e.action))
      return Array.from(set).sort()
    },
  },
})
