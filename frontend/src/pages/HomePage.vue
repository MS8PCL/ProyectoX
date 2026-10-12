<template>
  <div class="dashboard stack" style="gap: 24px">
    <div v-if="metricsError" class="card" role="alert" style="border-color: var(--color-danger)">{{ t('home.metricsError') }}: {{ metricsError }}</div>
    <!-- ═══ KPI Metrics Row ═══ -->
    <div class="kpi-row">
      <div class="kpi-card card">
        <div class="kpi-icon kpi-icon-indigo">
          <Briefcase :size="20" />
        </div>
        <div class="kpi-body">
          <div class="kpi-number">{{ kpiTotalListings }}</div>
          <div class="kpi-label">{{ t('home.totalListings') }}</div>
        </div>
        <div v-if="!desktop" class="kpi-trend kpi-trend-up">
          <TrendingUp :size="14" />
          <span>12%</span>
        </div>
      </div>

      <div class="kpi-card card">
        <div class="kpi-icon kpi-icon-emerald">
          <Users :size="20" />
        </div>
        <div class="kpi-body">
          <div class="kpi-number">{{ kpiTotalApplications }}</div>
          <div class="kpi-label">{{ app.role === 'empresa' ? t('home.totalCandidates') : t('home.totalApplications') }}</div>
        </div>
        <div v-if="!desktop" class="kpi-trend kpi-trend-up">
          <TrendingUp :size="14" />
          <span>8%</span>
        </div>
      </div>

      <div class="kpi-card card">
        <div class="kpi-icon kpi-icon-amber">
          <Clock :size="20" />
        </div>
        <div class="kpi-body">
          <div class="kpi-number">{{ kpiAvgTime }}<span v-if="!desktop || typeof kpiAvgTime === 'number'" class="kpi-unit">d</span></div>
          <div class="kpi-label">{{ t('home.avgTime') }}</div>
        </div>
        <div v-if="!desktop" class="kpi-trend kpi-trend-down">
          <TrendingDown :size="14" />
          <span>3d</span>
        </div>
      </div>

      <div class="kpi-card card">
        <div class="kpi-icon kpi-icon-violet">
          <Target :size="20" />
        </div>
        <div class="kpi-body">
          <div class="kpi-number">{{ kpiConversionRate }}<span class="kpi-unit">%</span></div>
          <div class="kpi-label">{{ t('home.conversionRate') }}</div>
        </div>
        <div v-if="!desktop" class="kpi-trend kpi-trend-up">
          <TrendingUp :size="14" />
          <span>5%</span>
        </div>
      </div>
    </div>

    <!-- ═══ 2-Column Grid ═══ -->
    <div class="dashboard-grid">
      <!-- ── Left Column ── -->
      <div class="stack" style="gap: 24px">
        <!-- Bar Chart: Pipeline por etapa -->
        <div class="card chart-card">
          <div class="chart-header">
            <h3 class="text-lg font-semibold">{{ t('home.pipelineByStage') }}</h3>
            <span class="badge badge-neutral">{{ totalPipeline }} {{ t(desktop ? 'home.totalApplications' : 'home.totalCandidates').toLowerCase() }}</span>
          </div>
          <div class="chart-body">
            <canvas ref="barCanvas"></canvas>
          </div>
        </div>

        <!-- Timeline: Actividad reciente -->
        <div class="card timeline-card">
          <div class="chart-header">
            <h3 class="text-lg font-semibold">{{ t('home.recentActivity') }}</h3>
            <span class="badge badge-info">Últimas 5</span>
          </div>
          <div class="timeline-list">
            <div
              v-for="(item, i) in recentActivity"
              :key="i"
              class="timeline-item"
            >
              <div class="timeline-avatar" :style="{ background: item.color }">
                <component :is="item.icon" :size="14" />
              </div>
              <div class="timeline-body">
                <div class="timeline-text">
                  <strong>{{ item.name }}</strong> {{ item.action }}
                </div>
                <div class="timeline-detail text-xs muted">{{ item.detail }}</div>
              </div>
              <div class="timeline-time text-xs muted">{{ item.time }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Right Column ── -->
      <div class="stack" style="gap: 24px">
        <!-- Doughnut: Ofertas por tipo -->
        <div class="card chart-card">
          <div class="chart-header">
            <h3 class="text-lg font-semibold">{{ t('home.listingsByKind') }}</h3>
          </div>
          <div class="chart-body chart-body-donut">
            <canvas ref="donutCanvas"></canvas>
            <div class="donut-legend">
              <div class="donut-legend-item">
                <span class="donut-dot donut-dot-indigo"></span>
                <span class="text-sm">{{ t('search.employment') }}</span>
                <span class="donut-count">{{ empleoCount }}</span>
              </div>
              <div class="donut-legend-item">
                <span class="donut-dot donut-dot-emerald"></span>
                <span class="text-sm">{{ t('search.freelance') }}</span>
                <span class="donut-count">{{ freelanceCount }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="card">
          <div class="chart-header">
            <h3 class="text-lg font-semibold">{{ t('home.quickActions') }}</h3>
          </div>
          <div class="quick-actions stack" style="gap: 0">
            <RouterLink class="quick-action" to="/publicar">
              <div class="qa-icon qa-icon-indigo">
                <PlusCircle :size="18" />
              </div>
              <div class="qa-body">
                <div class="font-semibold text-sm">{{ t('home.newOffer') }}</div>
                <div class="text-xs muted mt-2">{{ t('home.publishInfo') }}</div>
              </div>
              <ChevronRight :size="16" class="qa-arrow" />
            </RouterLink>
            <RouterLink class="quick-action" to="/enterprise/dashboard">
              <div class="qa-icon qa-icon-violet">
                <BarChart3 :size="18" />
              </div>
              <div class="qa-body">
                <div class="font-semibold text-sm">{{ t('home.enterpriseDashboard') }}</div>
                <div class="text-xs muted mt-2">{{ t('home.enterpriseDesc') }}</div>
              </div>
              <ChevronRight :size="16" class="qa-arrow" />
            </RouterLink>
            <RouterLink class="quick-action" to="/perfil">
              <div class="qa-icon qa-icon-emerald">
                <User :size="18" />
              </div>
              <div class="qa-body">
                <div class="font-semibold text-sm">{{ t('home.companyProfile') }}</div>
                <div class="text-xs muted mt-2">{{ t('home.keepData') }}</div>
              </div>
              <ChevronRight :size="16" class="qa-arrow" />
            </RouterLink>
            <RouterLink class="quick-action" to="/enterprise/rbac">
              <div class="qa-icon qa-icon-amber">
                <Shield :size="18" />
              </div>
              <div class="qa-body">
                <div class="font-semibold text-sm">{{ t('home.rbac') }}</div>
                <div class="text-xs muted mt-2">{{ t('home.manageRoles') }}</div>
              </div>
              <ChevronRight :size="16" class="qa-arrow" />
            </RouterLink>
            <RouterLink class="quick-action" to="/buscar">
              <div class="qa-icon qa-icon-rose">
                <Search :size="18" />
              </div>
              <div class="qa-body">
                <div class="font-semibold text-sm">{{ t('home.searchCandidates') }}</div>
                <div class="text-xs muted mt-2">{{ t('home.exploreTalent') }}</div>
              </div>
              <ChevronRight :size="16" class="qa-arrow" />
            </RouterLink>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch, nextTick } from 'vue'
import { useAppStore } from '../stores/app.js'
import { t } from '../lib/i18n.js'
import { api, isDesktop } from '../lib/api.js'
const desktop = isDesktop()
import {
  Briefcase, Users, Clock, Target, TrendingUp, TrendingDown,
  PlusCircle, BarChart3, User, Shield, Search, ChevronRight,
  FileText, UserPlus, MessageSquare, CheckCircle2, XCircle,
} from 'lucide-vue-next'
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  DoughnutController,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js'

// ── Register Chart.js components ──
Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  DoughnutController,
  ArcElement,
  Tooltip,
  Legend,
)

// ── Store ──
const app = useAppStore()
app.bootstrap()

// ── Server metrics ──
const serverMetrics = ref(null)
const metricsLoading = ref(false)
// The local fallback below can be stale; on desktop say so instead of passing it off as current.
const metricsError = ref('')

// ── Refs for canvases ──
const barCanvas = ref(null)
const donutCanvas = ref(null)
let barChart = null
let donutChart = null

// ── Computed: data (server or store fallback) ──
const totalCandidates = computed(() => {
  let n = 0
  const pipe = app.state?.pipeline || {}
  for (const arr of Object.values(pipe)) {
    if (Array.isArray(arr)) n += arr.length
  }
  return n
})

const totalPeople = computed(() => {
  if (app.role === 'empresa') return totalCandidates.value
  return app.state?.applications?.length ?? 0
})

// KPI values from server or fallback
const kpiTotalListings = computed(() => serverMetrics.value?.totalListings ?? app.listings.length)
const kpiTotalApplications = computed(() => desktop && app.role === 'empresa'
  ? (serverMetrics.value?.totalCandidates ?? app.state?.candidates?.length ?? 0)
  : (serverMetrics.value?.totalApplications ?? totalPeople.value))
const kpiAvgTime = computed(() => serverMetrics.value?.avgTimeToHire ?? (desktop ? '—' : 12))
const kpiConversionRate = computed(() => serverMetrics.value?.conversionRate ?? (desktop ? '—' : 34))

// Pipeline stages for bar chart (from server or store)
const employerStages = computed(() => {
  const serverStages = serverMetrics.value?.applicationsByStage
  if (serverStages) {
    if (Array.isArray(serverStages)) return serverStages.map((s, i) => ({
      key: s.key || s.stage || `stage_${i}`,
      label: s.label || s.key || s.stage || `Stage ${i}`,
      count: s.count ?? s.value ?? 0,
      color: s.color || ['#6366f1', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444'][i % 5],
    }))
    return Object.entries(serverStages).map(([key, count], i) => ({
      key, label: key, count,
      color: ['#6366f1', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444'][i % 5],
    }))
  }
  // Fallback to store
  const pipe = app.state?.pipeline || {}
  let nuevo = 0, revisar = 0, entrevista = 0, oferta = 0, descartado = 0
  for (const arr of Object.values(pipe)) {
    for (const c of (arr || [])) {
      if (c.stage === 'nuevo') nuevo++
      else if (c.stage === 'revisar') revisar++
      else if (c.stage === 'entrevista') entrevista++
      else if (c.stage === 'oferta') oferta++
      else if (c.stage === 'descartado') descartado++
    }
  }
  return [
    { key: 'nuevo', label: t('pipeline.nuevo'), count: nuevo, color: '#6366f1' },
    { key: 'revisar', label: t('pipeline.revisar'), count: revisar, color: '#f59e0b' },
    { key: 'entrevista', label: t('pipeline.entrevista'), count: entrevista, color: '#8b5cf6' },
    { key: 'oferta', label: t('pipeline.oferta'), count: oferta, color: '#10b981' },
    { key: 'descartado', label: t('pipeline.descartado'), count: descartado, color: '#ef4444' },
  ]
})

const totalPipeline = computed(() => {
  return employerStages.value.reduce((sum, s) => sum + s.count, 0)
})

// Listing types for donut (from server or store)
const empleoCount = computed(() => {
  const lk = serverMetrics.value?.listingsByKind
  if (lk) {
    if (Array.isArray(lk)) {
      const emp = lk.find(e => (e[0] || e.key || '').toLowerCase() === 'empleo')
      return emp ? (emp[1] ?? emp.count ?? 0) : 0
    }
    return lk.empleo || lk['empleo'] || 0
  }
  return app.listings.filter(l => l.kind === 'empleo').length
})
const freelanceCount = computed(() => {
  const lk = serverMetrics.value?.listingsByKind
  if (lk) {
    if (Array.isArray(lk)) {
      const free = lk.find(e => (e[0] || e.key || '').toLowerCase() === 'freelance')
      return free ? (free[1] ?? free.count ?? 0) : 0
    }
    return lk.freelance || lk['freelance'] || 0
  }
  return app.listings.filter(l => l.kind === 'freelance').length
})

// ── Recent activity (from server or store fallback) ──
const recentActivity = computed(() => {
  const serverRA = serverMetrics.value?.recentActivity
  if (Array.isArray(serverRA) && serverRA.length > 0) {
    return serverRA.slice(0, 5).map(item => ({
      name: item.name || item.user || 'Evento',
      action: item.action || item.description || '',
      detail: item.detail || item.details || '',
      time: item.timestamp ? relativeTime(new Date(item.timestamp)) : (item.time || 'recién'),
      icon: item.icon ? evalIcon(item.icon) : FileText,
      color: item.color || '#6366f1',
      ts: item.timestamp ? new Date(item.timestamp) : null,
    }))
  }
  // Fallback to store-derived data
  const items = []
  const pipe = app.state?.pipeline || {}
  for (const [listingId, entries] of Object.entries(pipe)) {
    if (!Array.isArray(entries)) continue
    const listing = app.listings.find(l => l.id === listingId)
    const listingTitle = listing?.title || 'Oferta'
    for (const entry of (entries || [])) {
      const name = entry.name || 'Candidato'
      const stage = entry.stage || 'nuevo'
      const ts = entry.createdAt ? new Date(entry.createdAt) : null
      items.push({
        name,
        action: stage === 'nuevo' ? 'aplicó a' : stage === 'oferta' ? 'recibió oferta en' : `avanzó a ${stage} en`,
        detail: listingTitle,
        time: ts ? relativeTime(ts) : 'recién',
        icon: stage === 'nuevo' ? FileText : stage === 'oferta' ? CheckCircle2 : stage === 'descartado' ? XCircle : MessageSquare,
        color: stage === 'nuevo' ? '#6366f1' : stage === 'oferta' ? '#10b981' : stage === 'descartado' ? '#ef4444' : '#f59e0b',
        ts,
      })
    }
  }
  const apps = app.state?.applications || []
  for (const a of apps) {
    const listing = app.listings.find(l => l.id === a.listingId)
    const listingTitle = listing?.title || 'Oferta'
    const ts = a.createdAt ? new Date(a.createdAt) : null
    items.push({
      name: app.role === 'candidato' ? 'Tú' : (a.candidateName || 'Candidato'),
      action: a.status === 'enviado' ? 'postuló a' : a.status === 'entrevista' ? 'pasó a entrevista en' : a.status === 'oferta' ? 'recibió oferta en' : 'fue rechazado en',
      detail: listingTitle,
      time: ts ? relativeTime(ts) : 'recién',
      icon: a.status === 'enviado' ? FileText : a.status === 'entrevista' ? MessageSquare : a.status === 'oferta' ? CheckCircle2 : XCircle,
      color: a.status === 'enviado' ? '#6366f1' : a.status === 'entrevista' ? '#f59e0b' : a.status === 'oferta' ? '#10b981' : '#ef4444',
      ts,
    })
  }
  items.sort((a, b) => {
    if (!a.ts && !b.ts) return 0
    if (!a.ts) return 1
    if (!b.ts) return -1
    return b.ts - a.ts
  })
  return items.slice(0, 5)
})

// Helper to resolve icon name from server data
function evalIcon(name) {
  const icons = { FileText, UserPlus, MessageSquare, CheckCircle2, XCircle, Users, Clock, Target }
  return icons[name] || FileText
}

// ── Relative time helper ──
function relativeTime(date) {
  const now = new Date()
  const diffMs = now - date
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return t('notifications.now')
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return t('notifications.minAgo', { n: diffMin })
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return t('notifications.hourAgo', { n: diffHr })
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return t('notifications.dayAgo', { n: diffDay })
  return t('notifications.dayAgo', { n: Math.floor(diffDay / 7) })
}

// ── Chart: Bar (Pipeline) ──
function renderBarChart() {
  if (!barCanvas.value) return
  if (barChart) barChart.destroy()

  const stages = employerStages.value
  const ctx = barCanvas.value.getContext('2d')

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stages.map(s => s.label),
      datasets: [{
        label: t('home.totalCandidates'),
        data: stages.map(s => s.count),
        backgroundColor: stages.map(s => s.color + 'CC'),
        borderColor: stages.map(s => s.color),
        borderWidth: 1.5,
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(9,9,11,0.92)',
          titleColor: '#fafafa',
          bodyColor: '#a1a1aa',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: false,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#a1a1aa',
            font: { size: 11, family: 'Inter, sans-serif' },
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#71717a',
            font: { size: 11, family: 'Inter, sans-serif' },
            stepSize: 1,
          },
        },
      },
    },
  })
}

// ── Chart: Doughnut (Ofertas por tipo) ──
function renderDonutChart() {
  if (!donutCanvas.value) return
  if (donutChart) donutChart.destroy()

  const ctx = donutCanvas.value.getContext('2d')
  const emp = empleoCount.value
  const free = freelanceCount.value

  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Empleo', 'Freelance'],
      datasets: [{
        data: [emp, free],
        backgroundColor: ['#6366f1', '#10b981'],
        borderColor: ['#6366f1', '#10b981'],
        borderWidth: 0,
        hoverBorderWidth: 2,
        hoverBorderColor: 'rgba(255,255,255,0.2)',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(9,9,11,0.92)',
          titleColor: '#fafafa',
          bodyColor: '#a1a1aa',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: true,
          boxPadding: 4,
        },
      },
    },
  })
}

// ── Load metrics from server ──
async function loadMetrics() {
  metricsLoading.value = true
  try {
    const res = await api('/metrics')
    serverMetrics.value = res || {}
    metricsError.value = ''
  } catch (e) {
    // Fallback a datos locales del store, avisando en escritorio de que pueden no estar al día.
    serverMetrics.value = null
    if (isDesktop()) metricsError.value = String(e?.message || e)
  } finally {
    metricsLoading.value = false
  }
}

// ── Lifecycle ──
onMounted(async () => {
  await loadMetrics()
  await nextTick()
  renderBarChart()
  renderDonutChart()
})

// Re-render when stage data or listing types change
watch([employerStages, empleoCount, freelanceCount], async () => {
  await nextTick()
  renderBarChart()
  renderDonutChart()
}, { deep: true })
</script>

<style scoped>
/* ═══ Dashboard Layout ═══ */
.dashboard {
  max-width: 1280px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  align-items: start;
}

/* ═══ KPI Row ═══ */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.kpi-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
}

.kpi-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.kpi-icon-indigo  { background: rgba(99, 102, 241, 0.15);  color: #6366f1; }
.kpi-icon-emerald { background: rgba(16, 185, 129, 0.15);  color: #10b981; }
.kpi-icon-amber   { background: rgba(245, 158, 11, 0.15);  color: #f59e0b; }
.kpi-icon-violet  { background: rgba(139, 92, 246, 0.15);  color: #8b5cf6; }

.kpi-body {
  flex: 1;
  min-width: 0;
}

.kpi-number {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--color-text);
  line-height: 1.1;
}

.kpi-unit {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-muted);
  margin-left: 2px;
}

.kpi-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 2px;
}

.kpi-trend {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.kpi-trend-up   { color: #10b981; }
.kpi-trend-down { color: #ef4444; }

/* ═══ Chart Cards ═══ */
.chart-card {
  padding: 24px;
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.chart-body {
  height: 260px;
  position: relative;
}

.chart-body-donut {
  height: 260px;
  display: flex;
  align-items: center;
  gap: 24px;
}

.chart-body-donut canvas {
  max-width: 180px;
  max-height: 180px;
  flex-shrink: 0;
}

/* ═══ Donut Legend ═══ */
.donut-legend {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.donut-legend-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.donut-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.donut-dot-indigo  { background: #6366f1; }
.donut-dot-emerald { background: #10b981; }

.donut-count {
  margin-left: auto;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}

/* ═══ Timeline ═══ */
.timeline-card {
  padding: 24px;
}

.timeline-list {
  display: flex;
  flex-direction: column;
}

.timeline-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--color-glass-border);
}

.timeline-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.timeline-item:first-child {
  padding-top: 0;
}

.timeline-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}

.timeline-body {
  flex: 1;
  min-width: 0;
}

.timeline-text {
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.4;
}

.timeline-text strong {
  font-weight: 600;
  color: var(--color-text);
}

.timeline-detail {
  margin-top: 2px;
}

.timeline-time {
  flex-shrink: 0;
  white-space: nowrap;
}

/* ═══ Quick Actions ═══ */
.quick-actions {
  padding: 4px 0;
}

.quick-action {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 24px;
  text-decoration: none;
  color: var(--color-text);
  transition: background 0.15s ease;
  border-radius: 8px;
}

.quick-action:hover {
  background: var(--color-surface-hover);
}

.quick-action + .quick-action {
  border-top: 1px solid var(--color-glass-border);
  border-radius: 0;
}

.qa-icon {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.qa-icon-indigo  { background: rgba(99, 102, 241, 0.12);  color: #6366f1; }
.qa-icon-violet  { background: rgba(139, 92, 246, 0.12);  color: #8b5cf6; }
.qa-icon-emerald { background: rgba(16, 185, 129, 0.12);  color: #10b981; }
.qa-icon-amber   { background: rgba(245, 158, 11, 0.12);  color: #f59e0b; }
.qa-icon-rose    { background: rgba(244, 63, 94, 0.12);   color: #f43f5e; }

.qa-body {
  flex: 1;
  min-width: 0;
}

.qa-arrow {
  color: var(--color-muted);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.quick-action:hover .qa-arrow {
  opacity: 1;
}

/* ═══ Responsive ═══ */
@media (max-width: 1024px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }

  .kpi-row {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .kpi-row {
    grid-template-columns: 1fr;
  }

  .chart-card {
    padding: 16px;
  }

  .chart-body {
    height: 220px;
  }

  .chart-body-donut {
    flex-direction: column;
    height: auto;
    gap: 16px;
  }

  .chart-body-donut canvas {
    max-width: 180px;
    max-height: 180px;
  }

  .timeline-card {
    padding: 16px;
  }

  .kpi-card {
    padding: 16px;
  }
}
</style>
