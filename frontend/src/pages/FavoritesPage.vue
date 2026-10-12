<template>
  <div class="stack">
    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <div>
          <div style="font-weight: 650">Favoritos</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            {{ app.role === 'empresa' ? 'Shortlist: candidatos marcados dentro del proceso de una oferta.' : 'Anuncios guardados.' }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="app.role !== 'empresa'" class="stack">
      <div v-for="l in favListings" :key="l.id" class="card row" style="justify-content: space-between">
        <div>
          <div style="font-weight: 650">★ {{ l.title }}</div>
          <div class="muted" style="font-size: 12px">{{ l.company }} · {{ l.location }} · {{ l.pay }}</div>
        </div>
        <div class="row" style="gap: 8px">
          <button class="btn" @click="app.openDrawer(l.id)">Ver</button>
          <button class="btn" @click="app.toggleFavorite(l.id)">Quitar</button>
        </div>
      </div>

      <div v-if="!favListings.length" class="card muted">(vacío)</div>
    </div>

    <div v-else class="stack">
      <div class="card muted">
        Favoritos no aplica para Empresa. (Listas se reimplementará en servidor en el siguiente paso.)
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
  await app.refreshFavoritesFromServer().catch(() => {})
})

const favListings = computed(() => app.listings.filter((l) => app.favorites.has(l.id)))
</script>
