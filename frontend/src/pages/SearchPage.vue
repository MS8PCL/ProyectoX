<template>
  <div class="stack" style="gap: 20px">
    <!-- Header -->
    <div class="card card-glass">
      <div class="row items-center justify-between" style="flex-wrap: wrap; gap: 12px">
        <div>
          <h2 class="text-lg font-bold">{{ t('search.title') }}</h2>
          <p class="text-sm muted" style="margin-top: 4px">{{ filtered.length }} {{ t('search.results') }} · {{ app.listings.length }} {{ t('search.total') }}</p>
        </div>
        <div class="row items-center" style="gap: 8px; flex-wrap: wrap">
          <select class="input" v-model="kind" style="width: 130px">
            <option value="todos">{{ t('search.all') }}</option>
            <option value="empleo">{{ t('search.employment') }}</option>
            <option value="ett">{{ t('search.ett') }}</option>
            <option value="becario">{{ t('search.intern') }}</option>
          </select>
          <select class="input" v-model="sort" style="width: 150px">
            <option value="relevancia">{{ t('search.relevance') }}</option>
            <option value="fecha">{{ t('search.date') }}</option>
            <option value="compensacion">{{ t('search.compensation') }}</option>
          </select>
          <div class="input-wrapper" style="width: 220px">
            <Search :size="14" class="input-icon-left" />
            <input class="input" v-model="q" :placeholder="t('search.searchPlaceholder')" style="padding-left: 36px" />
          </div>
        </div>
      </div>

      <!-- Active filters -->
      <div class="row items-center" style="gap: 8px; margin-top: 12px; flex-wrap: wrap" v-if="q.trim() || kind !== 'todos'">
        <span v-if="q.trim()" class="badge badge-info">
          {{ q.trim() }}
          <button @click="q = ''" style="background:none;border:none;color:inherit;cursor:pointer;padding:0;margin-left:4px">×</button>
        </span>
        <span v-if="kind !== 'todos'" class="badge badge-neutral">
          {{ kind }}
          <button @click="kind = 'todos'" style="background:none;border:none;color:inherit;cursor:pointer;padding:0;margin-left:4px">×</button>
        </span>
      </div>
    </div>

    <!-- Results grid -->
    <div class="search-layout">
      <!-- Left: list -->
      <div class="stack" style="gap: 8px">
        <button
          v-for="l in filtered"
          :key="l.id"
          class="search-item card"
          :class="{ 'search-item--active': selectedId === l.id }"
          @click="select(l.id)"
        >
          <div class="row items-center justify-between" style="width: 100%">
            <div style="flex: 1; min-width: 0">
              <div class="font-semibold truncate">{{ l.title }}</div>
              <div class="text-sm muted" style="margin-top: 4px">{{ l.company }} · {{ l.location }} · {{ l.pay || '—' }}</div>
              <div class="row items-center" style="gap: 6px; margin-top: 6px">
                <span class="badge badge-neutral text-xs">{{ l.kind }}</span>
                <span v-for="t in (l.tags || []).slice(0, 3)" :key="t" class="badge badge-info text-xs">{{ t }}</span>
              </div>
            </div>
            <button
              class="btn btn-icon btn-ghost"
              @click.stop="app.toggleFavorite(l.id)"
              :style="{ color: app.favorites.has(l.id) ? '#f59e0b' : '' }"
            >
              {{ app.favorites.has(l.id) ? '★' : '☆' }}
            </button>
          </div>
        </button>

        <div v-if="!filtered.length" class="card text-center muted" style="padding: 40px">
          <p>{{ t('search.noResults') }}</p>
          <p class="text-sm" style="margin-top: 4px">{{ t('search.adjustFilters') }}</p>
        </div>
      </div>

      <!-- Right: detail dock -->
      <aside v-if="canDock && selectedId" class="card search-dock">
        <div class="search-dock-header">
          <div>
            <div class="font-semibold">{{ t('search.detail') }}</div>
            <div class="text-sm muted">{{ selectedMeta }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="selectedId = null">
            <X :size="14" />
          </button>
        </div>
        <div class="search-dock-body">
          <ListingDetail :id="selectedId" @close="selectedId = null" />
        </div>
      </aside>
    </div>

    <!-- Favorites -->
    <div class="card card-glass">
      <div class="row items-center justify-between">
        <div>
          <h3 class="font-semibold">{{ t('search.favorites') }}</h3>
          <p class="text-sm muted">{{ favs.length }} {{ t('search.saved') }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" @click="showFavs = !showFavs">
          {{ showFavs ? t('search.hide') : t('search.show') }}
        </button>
      </div>

      <div v-if="showFavs" class="stack" style="margin-top: 12px; gap: 8px">
        <div v-for="l in favs" :key="l.id" class="row items-center justify-between" style="gap: 8px">
          <button class="search-item card card-sm" style="flex: 1" @click="select(l.id)">
            <div class="font-semibold text-sm">{{ l.title }}</div>
            <div class="text-sm muted">{{ l.company }}</div>
          </button>
          <button class="btn btn-ghost btn-sm" @click.stop="app.toggleFavorite(l.id)">{{ t('search.remove') }}</button>
        </div>
        <div v-if="!favs.length" class="text-sm muted">{{ t('search.empty') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { t } from '../lib/i18n.js'
import ListingDetail from '../components/ListingDetail.vue'
import { Search, X } from 'lucide-vue-next'

const app = useAppStore()
app.bootstrap()

const q = ref('')
const kind = ref('todos')
const sort = ref('relevancia')
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
  if (!l) return `(${t('search.notFound')})`
  return `${l.company} · ${l.location} · ${l.pay || ''}`
})

function select(id) {
  if (canDock.value) {
    selectedId.value = id
  } else {
    app.openDrawer(id)
  }
}
</script>

<style scoped>
.search-layout {
  display: grid;
  grid-template-columns: 1fr 480px;
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .search-layout {
    grid-template-columns: 1fr;
  }
}

.search-item {
  width: 100%;
  text-align: left;
  cursor: pointer;
  transition: all var(--transition-base);
  border: 1px solid var(--color-border);
  padding: 14px 16px;
}

.search-item:hover {
  border-color: var(--color-accent);
}

.search-item--active {
  border-color: var(--color-accent) !important;
  background: var(--color-surface-active) !important;
}

.search-dock {
  position: sticky;
  top: 16px;
  height: calc(100vh - 56px - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.search-dock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.search-dock-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.input-icon-left {
  position: absolute;
  left: 12px;
  color: var(--color-faint);
  pointer-events: none;
  z-index: 1;
}
</style>
