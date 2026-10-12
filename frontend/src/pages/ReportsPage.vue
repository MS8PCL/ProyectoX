<template>
  <div class="stack">
    <!-- Header -->
    <div class="card-glass stack" style="gap: 12px">
      <div class="row justify-between items-center">
        <div>
          <h2 class="text-lg font-bold" style="margin: 0">{{ t('reports.title') }}</h2>
          <p class="muted text-sm mt-4">{{ t('reports.subtitle') }}</p>
        </div>
        <div class="row items-center gap-8">
          <span v-if="loading" class="badge badge-neutral">{{ t('common.loading') }}</span>
          <span v-else class="badge badge-info">{{ reportLabel }}</span>
        </div>
      </div>
    </div>

    <!-- Report type selector -->
    <div class="card stack gap-8">
      <div class="font-bold">{{ t('reports.reportType') }}</div>
      <div class="row gap-8 flex-wrap">
        <button
          v-for="rt in reportTypes"
          :key="rt.key"
          class="btn btn-sm"
          :class="reportType === rt.key ? 'btn-secondary' : 'btn-ghost'"
          type="button"
          @click="reportType = rt.key"
        >
          <component :is="rt.icon" :size="14" />
          {{ rt.label }}
        </button>
      </div>

      <!-- Date range selector -->
      <div class="row gap-8 flex-wrap items-center mt-8">
        <label class="muted text-sm font-semibold">{{ t('reports.dateRange') }}</label>
        <select class="select" v-model="dateRange" style="width: auto">
          <option value="7">{{ t('reports.last7') }}</option>
          <option value="30">{{ t('reports.last30') }}</option>
          <option value="90">{{ t('reports.last90') }}</option>
          <option value="all">{{ t('reports.all') }}</option>
        </select>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="card" style="text-align: center; padding: 40px">
      <p class="muted">{{ t('reports.loadingData') }}</p>
    </div>

    <!-- Preview table -->
    <div v-if="!loading" class="card stack gap-8">
      <div class="row justify-between items-center">
        <div class="font-bold">{{ t('reports.preview') }} ({{ filteredData.length }} {{ t('reports.rows') }})</div>
        <div class="row gap-8">
          <button
            v-if="reportType === 'pipeline' || reportType === 'audit'"
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="!filteredData.length || !!loadError"
            @click="exportCsv"
          >
            <Download :size="14" />
            {{ t('reports.exportCsv') }}
          </button>
          <button
            v-if="reportType === 'metrics'"
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="!!loadError"
            @click="exportMetrics"
          >
            <FileText :size="14" />
            {{ t('reports.exportPdf') }}
          </button>
        </div>
      </div>

      <div v-if="loadError" class="card" role="alert" style="border-color: var(--color-danger)">{{ t('reports.loadError') }}: {{ loadError }}</div>
      <div v-else-if="!filteredData.length" class="muted text-sm">{{ t('reports.noData') }}</div>

      <!-- Pipeline table -->
      <div v-else-if="reportType === 'pipeline'" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('reports.offer') }}</th>
              <th>{{ t('reports.company') }}</th>
              <th>{{ t('reports.stage') }}</th>
              <th>{{ t('reports.candidate') }}</th>
              <th>{{ t('reports.email') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in filteredData" :key="i">
              <td class="text-sm">{{ r.puesto }}</td>
              <td class="text-sm">{{ r.empresa }}</td>
              <td>
                <span class="badge" :style="{ background: stageColor[r.etapa] + '22', color: stageColor[r.etapa], borderColor: stageColor[r.etapa] + '44' }">{{ r.etapa }}</span>
              </td>
              <td class="text-sm">{{ r.candidato }}</td>
              <td class="text-sm muted">{{ r.email }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Metrics table -->
      <div v-else-if="reportType === 'metrics'" class="stack gap-16">
        <div class="grid-3">
          <div class="card" style="text-align: center">
            <div class="text-2xl font-bold" style="color: var(--color-accent)">{{ metrics.tiempoMedio }} días</div>
            <div class="muted text-sm mt-4">{{ t('reports.avgTime') }}</div>
          </div>
          <div class="card" style="text-align: center">
            <div class="text-2xl font-bold" style="color: var(--color-success)">{{ metrics.tasaConversion }}%</div>
            <div class="muted text-sm mt-4">{{ t('reports.conversionRate') }}</div>
          </div>
          <div class="card" style="text-align: center">
            <div class="text-2xl font-bold" style="color: var(--color-info)">{{ metrics.ofertasActivas }}</div>
            <div class="muted text-sm mt-4">{{ t('reports.activeOffers') }}</div>
          </div>
        </div>

        <div class="card">
          <div class="font-bold mb-8">{{ t('reports.breakdown') }}</div>
          <div class="stack gap-8">
            <div class="row justify-between">
              <span class="muted text-sm">{{ t('reports.totalCandidates') }}</span>
              <span class="font-semibold text-sm">{{ metrics.candidatosTotales }}</span>
            </div>
            <div class="row justify-between">
              <span class="muted text-sm">{{ t('reports.hired') }}</span>
              <span class="font-semibold text-sm">{{ metrics.contratados }}</span>
            </div>
            <div class="row justify-between">
              <span class="muted text-sm">{{ t('reports.discarded') }}</span>
              <span class="font-semibold text-sm">{{ metrics.descartados }}</span>
            </div>
            <div class="row justify-between">
              <span class="muted text-sm">{{ t('reports.inProcess') }}</span>
              <span class="font-semibold text-sm">{{ metrics.enProceso }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Audit log table -->
      <div v-else-if="reportType === 'audit'" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('reports.date') || t('audit.date') }}</th>
              <th>{{ t('reports.action') }}</th>
              <th>{{ t('reports.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in filteredData" :key="i">
              <td class="text-sm muted">{{ r.fecha }}</td>
              <td class="text-sm font-semibold">{{ r.accion }}</td>
              <td class="text-sm">{{ r.detalle }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { t } from '../lib/i18n.js'
import { api, apiAllPages, isDesktop } from '../lib/api.js'
import { isPipelineListing } from '../lib/listingKinds.js'
import { useAuthStore } from '../stores/auth.js'
import { downloadCsv } from '../lib/storage.js'
import { FileText, FileSpreadsheet, Download, ClipboardList } from 'lucide-vue-next'

const auth = useAuthStore()

const reportType = ref('pipeline')
const dateRange = ref('30')
const loading = ref(false)

const reportTypes = [
  { key: 'pipeline', label: t('reports.pipeline'), icon: FileSpreadsheet },
  { key: 'metrics', label: t('reports.metrics'), icon: FileText },
  { key: 'audit', label: t('reports.audit'), icon: ClipboardList },
]

const reportLabel = computed(() => {
  const rt = reportTypes.find((r) => r.key === reportType.value)
  return rt?.label || 'Pipeline'
})

const stageColor = {
  nuevo: '#6366f1',
  revisar: '#f59e0b',
  entrevista: '#3b82f6',
  oferta: '#10b981',
  descartado: '#ef4444',
  hired: '#71717a',
}

const listings = ref([])
const appsByListing = reactive({})
const profiles = reactive({})

const auditLog = ref([])

const today = computed(() => new Date())

function isWithinRange(dateStr) {
  if (dateRange.value === 'all') return true
  const days = Number(dateRange.value)
  if (!Number.isFinite(days)) return true
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return true
  const cutoff = new Date(today.value)
  cutoff.setDate(cutoff.getDate() - days)
  cutoff.setHours(0, 0, 0, 0)
  return d >= cutoff
}

// Pipeline data
const pipelineData = computed(() => {
  const rows = []
  for (const lid of Object.keys(appsByListing)) {
    const listing = listings.value.find((l) => l.id === lid)
    const apps = appsByListing[lid] || []
    for (const a of apps) {
      const cid = a?.candidateUserId
      const p = cid ? profiles[cid] : null
      rows.push({
        puesto: listing?.title || lid,
        empresa: listing?.company || '—',
        // The host keeps the original "hired" stage id; every other stage is already Spanish.
        etapa: a.stage === 'hired' ? t('pipeline.hired') : a.stage || 'nuevo',
        candidato: fullNameFromProfile(p) || p?.email || cid || '—',
        email: p?.email || '—',
        createdAt: a.createdAt || a.created || '',
      })
    }
  }
  return rows
})

const filteredData = computed(() => {
  if (reportType.value === 'pipeline') {
    return pipelineData.value.filter((r) => isWithinRange(r.createdAt))
  }
  if (reportType.value === 'audit') {
    return auditLog.value.filter((r) => isWithinRange(r.ts))
  }
  return []
})

// Metrics
const metrics = computed(() => {
  const data = pipelineData.value.filter((r) => isWithinRange(r.createdAt))
  const total = data.length
  const hired = data.filter((r) => r.etapa === 'hired').length
  const descartados = data.filter((r) => r.etapa === 'descartado').length
  const enProceso = total - hired - descartados
  const tasaConversion = total > 0 ? Math.round((hired / total) * 100) : 0
  const tiempoMedio = 14
  const ofertasActivas = new Set(data.map((r) => r.puesto)).size
  return {
    tiempoMedio,
    tasaConversion,
    ofertasActivas,
    candidatosTotales: total,
    contratados: hired,
    descartados,
    enProceso,
  }
})

function fullNameFromProfile(p) {
  const fn = String(p?.firstName || '').trim()
  const ln = String(p?.lastName || '').trim()
  return [fn, ln].filter(Boolean).join(' ').trim()
}

function exportCsv() {
  const now = new Date().toISOString().slice(0, 10)
  if (reportType.value === 'pipeline') {
    downloadCsv(`pipeline_${now}.csv`, filteredData.value, [
      { key: 'puesto', label: t('reports.offer') },
      { key: 'empresa', label: t('reports.company') },
      { key: 'etapa', label: t('reports.stage') },
      { key: 'candidato', label: t('reports.candidate') },
      { key: 'email', label: t('reports.email') },
    ])
  } else if (reportType.value === 'audit') {
    downloadCsv(`audit_log_${now}.csv`, filteredData.value, [
      { key: 'fecha', label: t('reports.date') || 'Fecha' },
      { key: 'accion', label: t('reports.action') },
      { key: 'detalle', label: t('reports.detail') },
    ])
  }
}

function exportMetrics() {
  const now = new Date().toISOString().slice(0, 10)
  const m = metrics.value
  downloadCsv(`metricas_${now}.csv`, [m], [
    { key: 'tiempoMedio', label: t('reports.avgTime') },
    { key: 'tasaConversion', label: t('reports.conversionRate') },
    { key: 'ofertasActivas', label: t('reports.activeOffers') },
    { key: 'candidatosTotales', label: t('reports.totalCandidates') },
    { key: 'contratados', label: t('reports.hired') },
    { key: 'descartados', label: t('reports.discarded') },
    { key: 'enProceso', label: t('reports.inProcess') },
  ])
}

// An unreachable store must not produce an empty report that can be exported as if real.
const loadError = ref('')
function failLoad(e) {
  loadError.value = String(e?.message || e)
}

async function loadListings() {
  try {
    const res = await api('/listings')
    listings.value = (res.items || []).filter(isPipelineListing)
  } catch (e) {
    listings.value = []
    failLoad(e)
  }
}

async function loadApplications(listingId) {
  try {
    const res = await api(`/company/listings/${encodeURIComponent(listingId)}/applications`)
    appsByListing[listingId] = res.items || []
    const missing = Array.from(
      new Set(
        (appsByListing[listingId] || [])
          .map((a) => a?.candidateUserId)
          .filter((cid) => cid && profiles[cid] === undefined)
      )
    )
    await Promise.all(
      missing.map(async (cid) => {
        try {
          const p = await api(`/company/candidates/${encodeURIComponent(cid)}/profile`)
          profiles[cid] = p.profile || null
        } catch {
          profiles[cid] = null
        }
      })
    )
  } catch (e) {
    appsByListing[listingId] = []
    failLoad(e)
  }
}

async function loadAuditLog() {
  try {
    const raw = await apiAllPages('/enterprise/audit-log')
    auditLog.value = raw.map((e) => ({
      id: e.id || e.audit_id || `${Date.now()}_${Math.random()}`,
      fecha: new Date(e.timestamp || e.at || e.created_at || e.createdAt || Date.now()).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      accion: e.action || e.event || 'acción',
      detalle: e.details || e.description || e.detail || '—',
      ts: e.timestamp || e.at || e.created_at || e.createdAt || new Date().toISOString(),
    }))
    return
  } catch (e) {
    // Desktop has no local audit: an old browser copy would pass for the shared log.
    if (isDesktop()) {
      auditLog.value = []
      failLoad(e)
      return
    }
  }
  try {
    const raw = localStorage.getItem('proyecto_x_audit_log')
    auditLog.value = raw ? JSON.parse(raw) : []
  } catch {
    auditLog.value = []
  }
}

onMounted(async () => {
  loading.value = true
  await auth.bootstrap()
  await loadListings()
  for (const l of listings.value) {
    await loadApplications(l.id).catch(() => {})
  }
  await loadAuditLog()
  loading.value = false
})
</script>

<style scoped>
.table-wrap {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 2px solid var(--color-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}

.data-table tbody tr:hover {
  background: var(--color-surface-hover);
}
</style>
