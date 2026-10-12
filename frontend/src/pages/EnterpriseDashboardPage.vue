<template>
  <div class="stack">
    <header class="row" style="justify-content: space-between; align-items: end">
      <div>
        <h1 style="margin: 0">{{ t('metrics.dashboard') }}</h1>
        <p class="muted" style="margin: 6px 0 0">{{ t('metrics.subtitle') }}</p>
      </div>
      <button class="btn" @click="load" :disabled="loading">{{ t('common.reload') }}</button>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="card" style="text-align: center; padding: 40px">
      <p class="muted">{{ t('metrics.loadingMetrics') }}</p>
    </div>

    <!-- Error -->
    <div v-if="error && !loading" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
      <div class="mono" style="color: var(--danger)">{{ t('metrics.errorLoadMetrics') }}: {{ error }}</div>
    </div>

    <!-- KPI Row -->
    <div v-if="!loading" class="kpi-row">
      <div class="card kpi-card">
        <div class="kpi-body">
          <div class="kpi-number">{{ metrics.totalListings ?? 0 }}</div>
          <div class="kpi-label">{{ t('metrics.totalListings') }}</div>
        </div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-body">
          <div class="kpi-number">{{ metrics.totalApplications ?? 0 }}</div>
          <div class="kpi-label">{{ t('metrics.totalApplications') }}</div>
        </div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-body">
          <div class="kpi-number">{{ outboxPending.length }}</div>
          <div class="kpi-label">{{ t('metrics.outboxPending') }}</div>
        </div>
      </div>
    </div>

    <!-- Charts Row -->
    <div v-if="!loading" class="grid">
      <!-- Bar: applicationsByStage -->
      <div class="card chart-card">
        <div class="chart-header">
          <h3 class="text-lg font-semibold">{{ t('metrics.byStage') }}</h3>
        </div>
        <div class="chart-body">
          <canvas ref="barCanvas"></canvas>
        </div>
        <div v-if="!hasApplicationsByStage" class="muted text-sm" style="text-align:center; padding: 20px">{{ t('metrics.noDataStage') }}</div>
      </div>

      <!-- Donut: listingsByKind -->
      <div class="card chart-card">
        <div class="chart-header">
          <h3 class="text-lg font-semibold">{{ t('metrics.byKind') }}</h3>
        </div>
        <div class="chart-body chart-body-donut">
          <canvas ref="donutCanvas"></canvas>
          <div class="donut-legend">
            <div v-for="k in listingKindEntries" :key="k[0]" class="donut-legend-item">
              <span class="donut-dot" :style="{ background: kindColor(k[0]) }"></span>
              <span class="text-sm">{{ k[0] }}</span>
              <span class="donut-count">{{ k[1] }}</span>
            </div>
          </div>
        </div>
        <div v-if="!listingKindEntries.length" class="muted text-sm" style="text-align:center; padding: 20px">{{ t('metrics.noDataKind') }}</div>
      </div>
    </div>

    <!-- Timeline: recentActivity -->
    <div v-if="!loading && recentActivity.length" class="card timeline-card">
      <div class="chart-header">
        <h3 class="text-lg font-semibold">{{ t('metrics.recentActivity') }}</h3>
        <span class="badge badge-info">{{ recentActivity.length }} {{ t('metrics.eventsCount') }}</span>
      </div>
      <div class="timeline-list">
        <div v-for="(item, i) in recentActivity" :key="i" class="timeline-item">
          <div class="timeline-body">
            <div class="timeline-text">{{ item.description || item.action || 'Evento' }}</div>
            <div class="timeline-detail text-xs muted">{{ item.timestamp ? fmtDate(item.timestamp) : '' }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, computed, watch, nextTick } from 'vue'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api'
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

Chart.register(BarController, BarElement, CategoryScale, LinearScale, DoughnutController, ArcElement, Tooltip, Legend)

const loading = ref(false)
const error = ref('')
const metrics = ref({})
const outboxPending = ref([])

const barCanvas = ref(null)
const donutCanvas = ref(null)
let barChart = null
let donutChart = null

const KIND_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
const _kindColorIndex = {}
function kindColor(kind) {
  if (!_kindColorIndex[kind]) {
    _kindColorIndex[kind] = KIND_COLORS[Object.keys(_kindColorIndex).length % KIND_COLORS.length]
  }
  return _kindColorIndex[kind]
}

const hasApplicationsByStage = computed(() => {
  const s = metrics.value?.applicationsByStage
  return s && (Array.isArray(s) ? s.length > 0 : Object.keys(s).length > 0)
})

const listingKindEntries = computed(() => {
  const lk = metrics.value?.listingsByKind
  if (!lk) return []
  if (Array.isArray(lk)) return lk
  return Object.entries(lk)
})

const recentActivity = computed(() => {
  const ra = metrics.value?.recentActivity
  if (!Array.isArray(ra)) return []
  return ra.slice(0, 10)
})

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function getApplicationsByStageArray() {
  const s = metrics.value?.applicationsByStage
  if (!s) return []
  if (Array.isArray(s)) return s
  return Object.entries(s).map(([key, count]) => ({ key, label: key, count }))
}

function renderBarChart() {
  if (!barCanvas.value) return
  if (barChart) barChart.destroy()
  const stages = getApplicationsByStageArray()
  if (!stages.length) return
  const ctx = barCanvas.value.getContext('2d')
  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stages.map(s => s.label || s.key),
      datasets: [{
        label: t('metrics.totalApplications'),
        data: stages.map(s => s.count ?? s.value ?? 0),
        backgroundColor: stages.map((_, i) => KIND_COLORS[i % KIND_COLORS.length] + 'CC'),
        borderColor: stages.map((_, i) => KIND_COLORS[i % KIND_COLORS.length]),
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
        x: { grid: { display: false }, ticks: { color: '#a1a1aa', font: { size: 11, family: 'Inter, sans-serif' } } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#71717a', font: { size: 11, family: 'Inter, sans-serif' }, stepSize: 1 } },
      },
    },
  })
}

function renderDonutChart() {
  if (!donutCanvas.value) return
  if (donutChart) donutChart.destroy()
  const entries = listingKindEntries.value
  if (!entries.length) return
  const ctx = donutCanvas.value.getContext('2d')
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(e => e[0]),
      datasets: [{
        data: entries.map(e => e[1]),
        backgroundColor: entries.map((e) => kindColor(e[0])),
        borderWidth: 0,
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
        },
      },
    },
  })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [metricsRes, outboxRes] = await Promise.all([
      api('/metrics'),
      api('/enterprise/outbox?status=pending'),
    ])
    metrics.value = metricsRes || {}
    outboxPending.value = outboxRes?.items || []
    await nextTick()
    renderBarChart()
    renderDonutChart()
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

watch([() => metrics.value?.applicationsByStage, () => metrics.value?.listingsByKind], async () => {
  await nextTick()
  renderBarChart()
  renderDonutChart()
}, { deep: true })

onMounted(load)
</script>

<style scoped>
.stack { display: grid; gap: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* KPIs */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.kpi-card {
  padding: 20px 24px;
  text-align: center;
}
.kpi-number {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--color-text);
  line-height: 1.1;
}
.kpi-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 4px;
}

/* Charts */
.chart-card { padding: 24px; }
.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.chart-body { height: 260px; position: relative; }
.chart-body-donut {
  height: 260px;
  display: flex;
  align-items: center;
  gap: 24px;
}
.chart-body-donut canvas { max-width: 180px; max-height: 180px; flex-shrink: 0; }

/* Donut Legend */
.donut-legend { display: flex; flex-direction: column; gap: 12px; }
.donut-legend-item { display: flex; align-items: center; gap: 10px; }
.donut-dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
.donut-count { margin-left: auto; font-size: 14px; font-weight: 700; color: var(--color-text); }

/* Timeline */
.timeline-card { padding: 24px; }
.timeline-list { display: flex; flex-direction: column; }
.timeline-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--color-glass-border);
}
.timeline-item:last-child { border-bottom: none; padding-bottom: 0; }
.timeline-item:first-child { padding-top: 0; }
.timeline-body { flex: 1; min-width: 0; }
.timeline-text { font-size: 13px; color: var(--color-text); line-height: 1.4; }
.timeline-detail { margin-top: 2px; }

@media (max-width: 900px) {
  .grid { grid-template-columns: 1fr; }
  .kpi-row { grid-template-columns: 1fr; }
  .chart-body-donut { flex-direction: column; height: auto; gap: 16px; }
  .chart-body-donut canvas { max-width: 180px; max-height: 180px; }
}
</style>
