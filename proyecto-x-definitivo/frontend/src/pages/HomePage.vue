<template>
  <div class="stack">
    <div class="card">
      <div style="font-weight: 650">Estado</div>
      <div class="muted" style="margin-top: 6px">Tema: {{ themeLabel }} · Rol: {{ roleLabel }} · anuncios: {{ app.listings.length }}</div>
    </div>

    <div class="card">
      <div class="k">Workflow</div>
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        {{ app.role === 'candidato' ? 'El inicio es el tablero (candidaturas), no un menú.' : 'El inicio es el tablero (proceso de selección), no un menú.' }}
      </div>
      <div class="row" style="margin-top: 10px; flex-wrap: wrap">
        <RouterLink class="btn primary linkBtn" :to="app.role === 'candidato' ? '/candidaturas' : '/pipeline'">
          {{ app.role === 'candidato' ? 'Ver candidaturas' : 'Ver proceso de selección' }}
        </RouterLink>
        <RouterLink class="btn linkBtn" to="/buscar">Buscar</RouterLink>
        <RouterLink v-if="app.role === 'empresa'" class="btn linkBtn" to="/publicar">Publicar</RouterLink>
      </div>
    </div>

    <div v-if="app.role === 'candidato'" class="grid2">
      <div class="card">
        <div class="k">Resumen por estado</div>
        <div class="stack" style="margin-top: 10px">
          <div class="line">enviado <span class="muted">{{ byStatus.enviado }}</span></div>
          <div class="line">entrevista <span class="muted">{{ byStatus.entrevista }}</span></div>
          <div class="line">oferta <span class="muted">{{ byStatus.oferta }}</span></div>
          <div class="line">rechazado <span class="muted">{{ byStatus.rechazado }}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="k">Acciones</div>
        <div class="stack" style="margin-top: 10px">
          <RouterLink class="line" to="/buscar">Aplicar a ofertas <span class="muted">crear candidaturas</span></RouterLink>
          <RouterLink class="line" to="/perfil">Mejorar perfil <span class="muted">subir señales</span></RouterLink>
          <RouterLink class="line" to="/favoritos">Revisar guardados <span class="muted">priorizar</span></RouterLink>
        </div>
      </div>
    </div>

    <div v-else class="grid2">
      <div class="card">
        <div class="k">Proceso de Selección (total)</div>
        <div class="muted" style="font-size: 12px; margin-top: 6px">Candidatos sumados en todas las ofertas.</div>
        <div class="grid3" style="margin-top: 10px">
          <div class="mini"><div class="n">{{ pipeByStage.nuevo }}</div><div class="muted" style="font-size: 12px">nuevo</div></div>
          <div class="mini"><div class="n">{{ pipeByStage.revisar }}</div><div class="muted" style="font-size: 12px">revisar</div></div>
          <div class="mini"><div class="n">{{ pipeByStage.entrevista }}</div><div class="muted" style="font-size: 12px">entrevista</div></div>
          <div class="mini"><div class="n">{{ pipeByStage.oferta }}</div><div class="muted" style="font-size: 12px">oferta</div></div>
          <div class="mini"><div class="n">{{ pipeByStage.descartado }}</div><div class="muted" style="font-size: 12px">descartado</div></div>
        </div>
      </div>

      <div class="card">
        <div class="k">Acciones</div>
        <div class="stack" style="margin-top: 10px">
          <RouterLink class="line" to="/publicar">Publicar oferta <span class="muted">llenar embudo</span></RouterLink>
          <RouterLink class="line" to="/pipeline">Proceso de selección <span class="muted">mover etapas</span></RouterLink>
          <RouterLink class="line" to="/buscar">Buscar anuncios <span class="muted">ver mercado</span></RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAppStore } from '../stores/app.js'

const app = useAppStore()
app.bootstrap()

const themeLabel = computed(() => (app.theme === 'terminal' ? 'Oscuro' : 'Claro'))
const roleLabel = computed(() => (app.role === 'empresa' ? 'Empresa' : 'Candidato'))

const byStatus = computed(() => {
  const out = { enviado: 0, entrevista: 0, oferta: 0, rechazado: 0 }
  for (const a of app.state?.applications || []) {
    if (a && out[a.status] !== undefined) out[a.status]++
  }
  return out
})

const pipeByStage = computed(() => {
  const out = { nuevo: 0, revisar: 0, entrevista: 0, oferta: 0, descartado: 0 }
  const all = Object.values(app.state?.pipeline || {})
  for (const arr of all) {
    for (const c of arr || []) {
      if (c && out[c.stage] !== undefined) out[c.stage]++
    }
  }
  return out
})
</script>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.k {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.line {
  border: 1px solid var(--line);
  background: transparent;
  padding: 10px;
  text-decoration: none;
  color: inherit;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.line:hover {
  border-color: var(--line2);
}

.linkBtn {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}

.mini {
  border: 1px solid var(--line);
  background: transparent;
  padding: 10px;
}

.n {
  font-weight: 650;
  font-size: 18px;
}

@media (max-width: 900px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
  .grid3 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
