<template>
  <div class="wrap">
    <div class="head">
      <div>
        <div class="t">{{ c?.name || '(candidato)' }}</div>
        <div class="m">{{ [c?.title, c?.location].filter(Boolean).join(' · ') || '—' }}</div>
      </div>
      <button class="btn" @click="$emit('close')">Cerrar</button>
    </div>

    <hr class="sep" />

    <div v-if="!c" class="muted">Candidato no encontrado.</div>

    <div v-else class="stack" style="gap: 10px">
      <div v-if="!canViewFull" class="card muted" style="font-size: 12px">
        Perfil privado. Solo se muestra información completa si el candidato aplica o si la empresa ya lo tiene guardado.
      </div>

      <template v-else>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <span v-for="t in (c.tags || [])" :key="t" class="chip">{{ t }}</span>
          <span v-if="!(c.tags || []).length" class="muted" style="font-size: 12px">(sin tags)</span>
        </div>

        <div v-if="c.about" class="card">
          <div class="muted" style="font-size: 12px; margin-bottom: 6px">Sobre mí</div>
          <div style="white-space: pre-wrap">{{ c.about }}</div>
        </div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn" :disabled="!c.cvUrl" @click="openCv">Ver CV</button>
          <RouterLink class="btn" to="/listas">Ver Listas</RouterLink>
        </div>
      </template>

      <div class="card">
        <div class="muted" style="font-size: 12px; margin-bottom: 6px">Notas</div>
        <div class="muted" style="font-size: 12px">(MVP) Las notas por oferta están en el Proceso de Selección.</div>
      </div>

      <div class="muted" style="font-size: 12px">Este panel es temporal: consulta el perfil y ciérralo para volver al proceso.</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAppStore } from '../stores/app.js'

const props = defineProps({ id: { type: String, required: true } })
const app = useAppStore()

const c = computed(() => (app.candidates || []).find((x) => x.id === props.id) || null)

const isInAnyProcess = computed(() => {
  const cid = props.id
  const pipe = app.state?.pipeline || {}
  for (const list of Object.values(pipe)) {
    if (Array.isArray(list) && list.some((r) => r?.candidateId === cid)) return true
  }
  return false
})

const isInAnyList = computed(() => {
  const cid = props.id
  const members = app.state?.listMembers || {}
  for (const ids of Object.values(members)) {
    if (Array.isArray(ids) && ids.includes(cid)) return true
  }
  return false
})

const canViewFull = computed(() => {
  if (!c.value) return false
  // Privacy affects public browsing; once there is an explicit relationship (applied/saved), show full.
  if (c.value.public !== false) return true
  return isInAnyProcess.value || isInAnyList.value
})

function openCv() {
  if (!c.value?.cvUrl) return
  window.open(c.value.cvUrl, '_blank', 'noopener,noreferrer')
}
</script>

<style scoped>
.wrap {
  padding: 16px;
  height: 100%;
  overflow: auto;
}

.head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: start;
}

.t {
  font-weight: 700;
}

.m {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}

.sep {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 12px 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid var(--line);
  background: transparent;
  font-size: 12px;
}
</style>
