<template>
  <div class="stack" style="max-width: 1000px">
    <div class="card-glass stack" style="gap: 12px">
      <h2 class="text-lg font-bold" style="margin: 0">{{ t('audit.title') }}</h2>
      <p class="muted text-sm">{{ t('audit.subtitle') }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="card" style="text-align: center; padding: 40px">
      <p class="muted">{{ t('audit.loadingAudit') }}</p>
    </div>

    <!-- Server errors remain visible; desktop never falls back to demo entries. -->
    <div v-if="apiError && !loading" class="card" style="border-color: color-mix(in oklab, var(--warning) 50%, var(--line))">
      <div class="text-sm" style="color: var(--warning)">
        ⚠ {{ t('audit.serverError') }}
      </div>
    </div>

    <!-- Filters -->
    <div v-if="!loading" class="card row-wrap items-center gap-12">
      <div class="row items-center gap-8">
        <label class="muted text-sm">{{ t('audit.action') }}</label>
        <select class="input" v-model="actionFilter" style="max-width: 200px">
          <option value="">{{ t('audit.all') }}</option>
          <option v-for="a in uniqueActions" :key="a" :value="a">{{ a }}</option>
        </select>
      </div>
      <div class="row items-center gap-8">
        <label class="muted text-sm">{{ t('audit.from') }}</label>
        <input class="input" type="date" v-model="dateFrom" style="max-width: 160px" />
      </div>
      <div class="row items-center gap-8">
        <label class="muted text-sm">{{ t('audit.to') }}</label>
        <input class="input" type="date" v-model="dateTo" style="max-width: 160px" />
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="clearFilters">{{ t('common.clean') }}</button>
    </div>

    <!-- Table -->
    <div v-if="!loading" class="card" style="padding: 0; overflow: auto">
      <table class="audit-table">
        <thead>
          <tr>
            <th class="audit-th">Timestamp</th>
            <th class="audit-th">{{ t('audit.user') }}</th>
            <th class="audit-th">{{ t('audit.action') }}</th>
            <th class="audit-th">{{ t('audit.entity') }}</th>
            <th class="audit-th">{{ t('audit.details') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!paged.length">
            <td class="audit-td muted text-sm" colspan="5" style="text-align: center">{{ t('audit.noEvents') }}</td>
          </tr>
          <tr v-for="(e, i) in paged" :key="e.id" class="audit-row" :class="{ 'audit-row--alt': i % 2 === 1 }">
            <td class="audit-td">{{ fmtDate(e.timestamp) }}</td>
            <td class="audit-td">
              <code class="text-sm">{{ e.user }}</code>
            </td>
            <td class="audit-td">
              <span class="badge" :class="badgeClass(e.action)">{{ e.action }}</span>
            </td>
            <td class="audit-td muted text-sm">{{ e.entity }}</td>
            <td class="audit-td muted text-sm">{{ e.details }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="row justify-between items-center gap-8" v-if="totalPages > 1">
      <span class="muted text-sm">{{ filtered.length }} {{ t('audit.events') }} · {{ t('audit.page') }} {{ page }} {{ t('audit.of') || 'de' }} {{ totalPages }}</span>
      <div class="row gap-8">
        <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="page--">{{ t('audit.previous') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="page++">{{ t('audit.next') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useAuditStore } from '../stores/audit.js'
import { t } from '../lib/i18n.js'
import { apiAllPages } from '../lib/api.js'
import { isDesktopMode } from '../lib/storage.js'

const auditStore = useAuditStore()

const loading = ref(false)
const apiError = ref(false)
const serverEntries = ref([])
const serverLoaded = ref(false)

const actionFilter = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const page = ref(1)
const pageSize = 10

// A successful empty response is authoritative, not a request for demo data.
onMounted(async () => {
  loading.value = true
  apiError.value = false
  try {
    const raw = await apiAllPages('/enterprise/audit-log')
    serverEntries.value = raw.map((e) => ({
      id: e.id || e.audit_id || `${Date.now()}_${Math.random()}`,
      timestamp: e.timestamp || e.at || e.created_at || e.createdAt || new Date().toISOString(),
      user: e.user || e.email || e.actor || t('audit.system'),
      action: e.action || e.event || 'acción',
      icon: e.icon,
      entity: e.entity || e.entity_type || e.resource || '—',
      details: e.details || e.description || e.detail || '—',
    }))
    serverLoaded.value = true
    auditStore.entries = serverEntries.value
  } catch {
    apiError.value = true
    serverEntries.value = []
  } finally {
    loading.value = false
  }
})

// Preserve web fallback only for failed requests; desktop uses real events only.
const allEntries = computed(() => {
  if (serverLoaded.value || isDesktopMode()) return serverEntries.value
  return auditStore.allEntries
})

const uniqueActions = computed(() => {
  const set = new Set(allEntries.value.map((e) => e.action))
  return Array.from(set).sort()
})

const filtered = computed(() => {
  let list = allEntries.value
  if (actionFilter.value) list = list.filter((e) => e.action === actionFilter.value)
  if (dateFrom.value) {
    // Local midnight, like dateTo; a bare YYYY-MM-DD would parse as UTC midnight.
    const from = new Date(dateFrom.value + 'T00:00:00')
    list = list.filter((e) => new Date(e.timestamp) >= from)
  }
  if (dateTo.value) {
    const to = new Date(dateTo.value + 'T23:59:59')
    list = list.filter((e) => new Date(e.timestamp) <= to)
  }
  return list
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))

// A narrower filter can leave the current page past the end, where the pager is hidden.
watch([actionFilter, dateFrom, dateTo], () => { page.value = 1 })

const paged = computed(() => {
  const start = (page.value - 1) * pageSize
  return filtered.value.slice(start, start + pageSize)
})

function clearFilters() {
  actionFilter.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  page.value = 1
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function badgeClass(action) {
  if (action.includes('public') || action.includes('creó')) return 'badge-success'
  if (action.includes('elimin') || action.includes('descart')) return 'badge-danger'
  if (action.includes('inició') || action.includes('cambió') || action.includes('mov')) return 'badge-info'
  if (action.includes('export') || action.includes('import')) return 'badge-warning'
  return 'badge-neutral'
}
</script>

<style>
.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.audit-th {
  text-align: left;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-muted);
  font-weight: 600;
  white-space: nowrap;
}

.audit-td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

.audit-row:hover {
  background: var(--color-surface-hover);
}

.audit-row--alt {
  background: color-mix(in oklab, var(--color-surface-hover) 50%, var(--color-bg));
}

.audit-row--alt:hover {
  background: var(--color-surface-hover);
}
</style>
