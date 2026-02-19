<template>
  <div class="stack">
    <div class="card">
      <div style="font-weight: 650">Candidaturas</div>
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        El estado lo actualiza la empresa. Aquí solo ves en qué punto está tu candidatura.
      </div>
    </div>

    <div v-if="app.role !== 'candidato'" class="card muted">
      Esta sección es para Candidato. En Empresa usa "Proceso de Selección".
    </div>

    <div v-else class="stack">
      <div v-for="a in sortedApps" :key="a.id" class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start">
          <div>
            <div style="font-weight: 650">{{ byId[a.listingId]?.title || a.listingId }}</div>
            <div class="muted" style="font-size: 12px">{{ byId[a.listingId]?.company || '—' }}</div>
          </div>
          <span class="kbd">Estado: {{ a.status }}</span>
        </div>
        <div class="row" style="margin-top: 10px; justify-content: flex-end; gap: 8px">
          <button class="btn" @click="app.toggleFavorite(a.listingId)">
            {{ app.favorites.has(a.listingId) ? '★' : '☆' }}
          </button>
          <button class="btn" @click="app.openDrawer(a.listingId)">Ver anuncio</button>
        </div>
      </div>

      <div v-if="!app.applications.length" class="card muted">
        (vacío) — ve a Buscar y pulsa “Aplicar”.
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'

const app = useAppStore()

onMounted(async () => {
  await app.bootstrap()
  // Source of truth: server
  await app.refreshMyApplicationsFromServer().catch(() => {})
})

const byId = computed(() => Object.fromEntries(app.listings.map((l) => [l.id, l])))

const sortedApps = computed(() => {
  const arr = Array.isArray(app.applications) ? app.applications.slice() : []
  return arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
})
</script>
