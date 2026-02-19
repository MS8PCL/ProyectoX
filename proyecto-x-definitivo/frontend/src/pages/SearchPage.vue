<template>
  <div class="stack">
    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <div>
          <div style="font-weight: 650">Buscar</div>
          <div class="muted" style="font-size: 12px">Patrón tipo LinkedIn: lista + detalle sin perder contexto.</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; justify-content: flex-end">
          <select class="select" v-model="kind">
            <option value="todos">todos</option>
            <option value="empleo">empleo</option>
            <option value="freelance">freelance</option>
          </select>
          <select class="select" v-model="sort">
            <option value="relevancia">relevancia</option>
            <option value="fecha">fecha</option>
            <option value="compensacion">compensación</option>
          </select>
          <select class="select" v-model="density">
            <option value="normal">normal</option>
            <option value="compacta">compacta</option>
          </select>
          <input class="input" v-model="q" placeholder="buscar..." style="width: 240px" />
        </div>
      </div>

      <div class="chipbar" aria-label="Filtros activos" style="margin-top: 10px">
        <span v-if="q.trim()" class="fchip">Q: <strong>{{ q.trim() }}</strong> <button type="button" @click="q = ''">x</button></span>
        <span v-if="kind !== 'todos'" class="fchip">TIPO: <strong>{{ kind }}</strong> <button type="button" @click="kind = 'todos'">x</button></span>
        <span v-if="sort !== 'relevancia'" class="fchip">ORDEN: <strong>{{ sortLabel }}</strong></span>
        <span v-if="density !== 'normal'" class="fchip">DENSIDAD: <strong>{{ density }}</strong></span>
        <span v-if="!q.trim() && kind === 'todos'" class="muted" style="font-size: 12px">(sin filtros activos)</span>
      </div>
    </div>

    <div class="searchGrid">
      <div class="left">
        <div class="card" style="margin-bottom: 10px">
          <div class="row" style="justify-content: space-between; align-items: baseline">
            <div>
              <div style="font-weight: 650">Resultados</div>
              <div class="muted" style="font-size: 12px; margin-top: 6px">{{ filtered.length }} items</div>
            </div>
            <div class="muted" style="font-size: 12px">Haz click para ver detalle.</div>
          </div>
        </div>

        <div class="stack" role="list" :class="{ compact: density === 'compacta' }">
          <button
            v-for="l in filtered"
            :key="l.id"
            class="item"
            role="listitem"
            :data-active="selectedId === l.id"
            @click="select(l.id)"
            @keydown.enter.prevent="select(l.id)"
          >
            <div>
              <div class="t">{{ l.title }}</div>
              <div class="m">{{ l.company }} · {{ l.location }} · {{ l.pay }}</div>
              <div class="m" style="margin-top: 6px">{{ matchLine(l) }}</div>
            </div>
            <div class="row" style="gap: 8px">
              <span class="chip">{{ l.kind }}</span>
              <button
                class="star"
                type="button"
                @click.stop="app.toggleFavorite(l.id)"
                :aria-label="app.favorites.has(l.id) ? 'Quitar favorito' : 'Marcar favorito'"
              >
                {{ app.favorites.has(l.id) ? '★' : '☆' }}
              </button>
            </div>
          </button>

          <div v-if="!filtered.length" class="card muted">(sin resultados)</div>
        </div>
      </div>

      <aside v-if="canDock && selectedId" class="dock" aria-label="Detalle (dock)">
        <div class="dockHead">
          <div>
            <div class="dockTitle">Detalle</div>
            <div class="muted" style="font-size: 12px">{{ selectedMeta }}</div>
          </div>
          <button class="btn" @click="selectedId = null">Limpiar</button>
        </div>

        <ListingDetail :id="selectedId" @close="selectedId = null" />
      </aside>
    </div>

    <div class="card">
      <div class="row" style="justify-content: space-between">
        <div>
          <div style="font-weight: 650">Favoritos</div>
          <div class="muted" style="font-size: 12px">{{ favs.length }} items</div>
        </div>
        <button class="btn" @click="showFavs = !showFavs">{{ showFavs ? 'Ocultar' : 'Ver' }}</button>
      </div>

      <div v-if="showFavs" class="stack" style="margin-top: 10px">
        <div v-for="l in favs" :key="l.id" class="itemRow">
          <button class="item" type="button" @click="select(l.id)">
            <div>
              <div class="t">{{ l.title }}</div>
              <div class="m">{{ l.company }}</div>
            </div>
          </button>
          <button class="btn" type="button" @click.stop="app.toggleFavorite(l.id)">Quitar</button>
        </div>
        <div v-if="!favs.length" class="muted">(vacío)</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import ListingDetail from '../components/ListingDetail.vue'

const app = useAppStore()
app.bootstrap()

const q = ref('')
const kind = ref('todos')
const sort = ref('relevancia')
const density = ref('normal')
const showFavs = ref(false)

const selectedId = ref(null)

const canDock = ref(false)
let mq

onMounted(() => {
  mq = window.matchMedia('(min-width: 1100px)')
  const sync = () => (canDock.value = !!mq.matches)
  sync()
  mq.addEventListener?.('change', sync)
  mq.addListener?.(sync)
})

onBeforeUnmount(() => {
  if (!mq) return
  mq.removeEventListener?.('change', () => {})
  // (legacy removeListener not critical here)
})

const sortLabel = computed(() => {
  if (sort.value === 'fecha') return 'fecha'
  if (sort.value === 'compensacion') return 'compensación'
  return 'relevancia'
})

function score(l) {
  const query = q.value.trim().toLowerCase()
  if (!query) return 0
  const title = (l.title || '').toLowerCase()
  const tags = (l.tags || []).join(' ').toLowerCase()
  const desc = (l.desc || '').toLowerCase()
  let s = 0
  if (title.includes(query)) s += 3
  if (tags.includes(query)) s += 2
  if (desc.includes(query)) s += 1
  return s
}

function compValue(l) {
  const m = String(l.pay || '').replaceAll('.', '').match(/(\d{2,6})/)
  return m ? Number(m[1]) : 0
}

const filtered = computed(() => {
  const query = q.value.trim().toLowerCase()
  const items = app.listings
    .filter((l) => (kind.value === 'todos' ? true : l.kind === kind.value))
    .filter((l) => {
      if (!query) return true
      const hay = `${l.title} ${l.company} ${l.location} ${(l.tags || []).join(' ')} ${l.desc}`.toLowerCase()
      return hay.includes(query)
    })

  if (sort.value === 'compensacion') return items.slice().sort((a, b) => compValue(b) - compValue(a))
  if (sort.value === 'fecha') return items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return items.slice().sort((a, b) => score(b) - score(a))
})

const favs = computed(() => app.listings.filter((l) => app.favorites.has(l.id)))

const selectedMeta = computed(() => {
  if (!selectedId.value) return '—'
  const l = app.listings.find((x) => x.id === selectedId.value)
  if (!l) return '(no encontrado)'
  return `${l.company} · ${l.location} · ${l.pay}`
})

function matchLine(l) {
  const parts = []
  if (q.value.trim()) parts.push(`MATCH: ${score(l)}`)
  parts.push(`TIPO: ${l.kind}`)
  if (l.location) parts.push(`LOC: ${l.location}`)
  return parts.join(' · ')
}

function select(id) {
  if (canDock.value) {
    selectedId.value = id
  } else {
    app.openDrawer(id)
  }
}
</script>

<style scoped>
.searchGrid {
  display: grid;
  grid-template-columns: 1fr 520px;
  gap: 12px;
  align-items: start;
}

@media (max-width: 1100px) {
  .searchGrid {
    grid-template-columns: 1fr;
  }
}

.dock {
  position: sticky;
  top: 16px;
  border: 1px solid var(--line);
  background: var(--card);
  height: calc(100vh - 32px);
  overflow: auto;
}

.dockHead {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.dockTitle {
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 12px;
}

.chipbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.fchip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line2);
  background: transparent;
  padding: 6px 8px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.fchip strong {
  color: var(--ink);
  font-weight: 650;
}

.fchip button {
  border: 1px solid var(--line2);
  background: transparent;
  color: var(--muted);
  padding: 2px 6px;
  font: inherit;
  cursor: pointer;
}

.fchip button:hover {
  border-color: var(--line2);
  color: var(--ink);
}

.itemRow {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
}

.item {
  width: 100%;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--card);
  padding: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.item[data-active='true'] {
  border-color: var(--line2);
  background: var(--card2);
}

.item:hover {
  border-color: var(--line2);
}

.compact .item {
  padding: 10px;
}

.compact .item .m {
  display: none;
}

.t {
  font-weight: 650;
}

.m {
  font-size: 12px;
  color: var(--muted);
}

.chip {
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  background: var(--card2);
}

.star {
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  background: var(--card2);
  color: inherit;
  cursor: pointer;
}

.star:hover {
  border-color: var(--line2);
}
</style>
