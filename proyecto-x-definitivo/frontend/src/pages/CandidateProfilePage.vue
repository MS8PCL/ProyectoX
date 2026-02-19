<template>
  <div class="stack">
    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <div>
          <div style="font-weight: 650">Perfil profesional</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">Vista Empresa (solo lectura).</div>
        </div>
        <RouterLink class="btn" to="/candidatos">Volver</RouterLink>
      </div>
    </div>

    <div v-if="app.role !== 'empresa'" class="card muted">Esta vista es para Empresa.</div>

    <div v-else class="card">
      <div v-if="!candidate" class="muted">Candidato no encontrado.</div>

      <div v-else class="stack">
        <div>
          <div style="font-weight: 700; font-size: 16px">{{ candidate.name || '—' }}</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            {{ [candidate.title, candidate.location].filter(Boolean).join(' · ') || '—' }}
          </div>
        </div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <span v-for="t in (candidate.tags || [])" :key="t" class="chip">{{ t }}</span>
          <span v-if="!(candidate.tags || []).length" class="muted" style="font-size: 12px">(sin tags)</span>
        </div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn" :disabled="!candidate.cvUrl" @click="openCv">Ver CV</button>
          <RouterLink class="btn" to="/listas">Añadir a listas</RouterLink>
        </div>

        <div class="muted" style="font-size: 12px">
          Nota: en el MVP demo este perfil viene del “directorio de candidatos” (name/title/location/tags/cv). Más adelante puede venir de PocketBase.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '../stores/app.js'

const route = useRoute()
const app = useAppStore()
app.bootstrap()

const candidateId = computed(() => String(route.params?.candidateId || ''))
const candidate = computed(() => (app.candidates || []).find((c) => c.id === candidateId.value) || null)

function openCv() {
  if (!candidate.value?.cvUrl) return
  window.open(candidate.value.cvUrl, '_blank', 'noopener,noreferrer')
}
</script>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  background: transparent;
  font-size: 12px;
}
</style>
