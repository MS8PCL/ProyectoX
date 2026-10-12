<template>
  <div class="wrap">
    <div class="head">
      <div>
        <div class="t">{{ l.title }}</div>
        <div class="m">{{ l.company }} · {{ l.location }} · {{ l.pay }}</div>
      </div>
      <button class="btn" @click="$emit('close')">Cerrar</button>
    </div>

    <hr class="sep" />

    <div class="row" style="justify-content: space-between; align-items: flex-start">
      <div class="stack" style="gap: 6px">
        <div class="m">Tipo: <span class="muted">{{ l.kind }}</span></div>
        <div class="m">Tags: <span class="muted">{{ (l.tags || []).join(', ') || '—' }}</span></div>
      </div>

      <div class="row" style="gap: 8px">
        <button class="btn" @click="app.toggleFavorite(l.id)">
          {{ app.favorites.has(l.id) ? '★ Favorito' : '☆ Favorito' }}
        </button>
        <button v-if="app.role === 'candidato'" class="btn primary" @click="app.applyToListingServer(l.id)">
          Aplicar
        </button>
      </div>
    </div>

    <div class="card" style="margin-top: 10px">
      <div class="muted" style="font-size: 12px; margin-bottom: 6px">Descripción</div>
      <div style="white-space: pre-wrap">{{ l.desc }}</div>
    </div>

    <div v-if="app.role === 'empresa'" class="card" style="margin-top: 10px">
      <div class="row" style="justify-content: space-between; align-items: center">
        <div>
          <div style="font-weight: 650">Proceso de Selección</div>
          <div class="muted" style="font-size: 12px">Gestiona aplicantes y mueve etapas dentro del anuncio.</div>
        </div>
        <RouterLink class="btn" :to="`/proceso-server?listingId=${encodeURIComponent(l.id)}`">Abrir</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAppStore } from '../stores/app.js'

const props = defineProps({ id: { type: String, required: true } })
const app = useAppStore()

const l = computed(() => app.listings.find((x) => x.id === props.id) || { id: props.id, title: '(no encontrado)', tags: [] })
</script>

<style scoped>
.wrap {
  padding: 16px;
  height: 100%;
  overflow: auto;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.t {
  font-size: 16px;
  font-weight: 650;
}

.m {
  font-size: 12px;
  color: var(--muted);
}

.cand {
  display: grid;
  grid-template-columns: 1fr 150px;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--line);
  padding: 10px;
  background: var(--card2);
}
</style>
