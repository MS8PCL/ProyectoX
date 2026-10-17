<template>
  <div class="stack">
    <header class="row" style="justify-content: space-between; align-items: end">
      <div>
        <h1 style="margin: 0">{{ t('outbox.title') }}</h1>
        <p class="muted" style="margin: 6px 0 0">{{ t('outbox.subtitle') }}</p>
      </div>
      <div class="row" style="gap: 10px">
        <label class="muted">{{ t('outbox.status') }}</label>
        <select class="input" v-model="status">
          <option value="">{{ t('outbox.all') }}</option>
          <option value="pending">{{ t('outbox.pending') }}</option>
          <option value="processing">{{ t('outbox.processing') }}</option>
          <option value="completed">{{ t('outbox.completed') }}</option>
          <option value="failed">{{ t('outbox.failed') }}</option>
        </select>
        <button class="btn" @click="load" :disabled="loading">{{ t('outbox.reload') }}</button>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="card" style="text-align: center; padding: 40px">
      <p class="muted">{{ t('outbox.loadingItems') }}</p>
    </div>

    <!-- Error -->
    <div v-if="error && !loading" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
      <div class="mono" style="color: var(--danger)">{{ error }}</div>
    </div>

    <!-- Items -->
    <div v-if="!loading" class="card">
      <div class="row" style="justify-content: space-between">
        <span class="muted">{{ t('outbox.items') }}</span>
        <span class="kbd">{{ items.length }}</span>
      </div>

      <div v-if="!items.length" class="muted text-sm" style="text-align: center; padding: 30px 0">
        {{ t('outbox.empty') }}
      </div>

      <div class="list" style="margin-top: 10px">
        <div v-for="it in items" :key="it.id" class="item">
          <div class="row" style="justify-content: space-between; align-items: center">
            <div>
              <div style="font-weight: 650">{{ it.kind }}</div>
              <div class="muted mono">{{ it.entity_type }}:{{ it.entity_id }} · status={{ it.status }}</div>
              <div class="muted mono" style="font-size: 11px">idem={{ it.idempotency_key }}</div>
              <!-- IT processes the onboarding by hand, so it needs the snapshot, not just ids. -->
              <dl v-if="hireDetails(it).length" class="outbox-details">
                <template v-for="[label, value] in hireDetails(it)" :key="label">
                  <dt class="muted">{{ label }}</dt>
                  <dd>{{ value }}</dd>
                </template>
              </dl>
            </div>
            <div class="row" style="gap: 8px">
              <button
                v-if="it.status === 'pending' || it.status === 'processing'"
                class="btn btn-sm"
                :disabled="markingId === it.id"
                @click="markCompleted(it)"
              >
                {{ markingId === it.id ? t('outbox.completing') : t('outbox.markCompleted') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api'

const status = ref('pending')
const items = ref([])
const loading = ref(false)
const error = ref('')
const markingId = ref(null)

function hireDetails(it) {
  const blob = it?.export_blob || {}
  const hire = blob.hire_profile || {}
  const candidate = blob.candidate || {}
  const name = candidate.fullName || candidate.name || [candidate.firstName, candidate.lastName].filter(Boolean).join(' ')
  const start = hire.startDate ? new Date(hire.startDate) : null
  const manager = [hire.managerName, hire.managerEmail].filter(Boolean).join(' · ')
  return [
    [t('outbox.detailCandidate'), [name, candidate.email].filter(Boolean).join(' · ')],
    [t('outbox.detailListing'), blob.listing?.title],
    [t('outbox.detailDepartment'), blob.department?.name],
    [t('outbox.detailJobTitle'), blob.jobTitle?.name],
    [t('outbox.detailStartDate'), start && !Number.isNaN(start.getTime()) ? start.toLocaleDateString('es-ES', { timeZone: 'UTC' }) : ''],
    [t('outbox.detailCostCenter'), hire.costCenter],
    [t('outbox.detailManager'), manager],
    [t('outbox.detailAccess'), hire.accessProfileId],
    [t('outbox.detailHardware'), hire.hardwareProfile],
    [t('outbox.detailNotes'), hire.notesIT],
  ].filter(([, value]) => value)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const qs = status.value ? `?status=${encodeURIComponent(status.value)}` : ''
    const res = await api(`/enterprise/outbox${qs}`)
    items.value = res.items || []
  } catch (e) {
    const msg = String(e?.message || e)
    error.value = msg
    if (msg.startsWith('API 401:')) {
      const next = encodeURIComponent('/interno/altas')
      window.location.href = `/login?next=${next}`
    }
  } finally {
    loading.value = false
  }
}

async function markCompleted(it) {
  error.value = ''
  markingId.value = it.id
  try {
    await api(`/enterprise/outbox/${encodeURIComponent(it.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    })
    await load()
  } catch (e) {
    try {
      await api(`/enterprise/outbox/${encodeURIComponent(it.id)}/complete`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    } catch {
    }
    await load()
  } finally {
    markingId.value = null
  }
}

import { watch } from 'vue'
watch(status, () => { load() })

onMounted(load)
</script>

<style>
.outbox-details { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 13px; }
.outbox-details dd { margin: 0; }
</style>

<style scoped>
.stack { display: grid; gap: 16px; }
.input { border: 1px solid var(--line); background: var(--card); color: inherit; padding: 8px 10px; border-radius: 4px; }
.list { display: grid; gap: 10px; }
.item { border: 1px solid var(--line); background: var(--card2); padding: 12px; border-radius: 4px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
