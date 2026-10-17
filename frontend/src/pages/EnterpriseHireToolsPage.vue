<template>
  <div class="stack">
    <header>
      <h1 style="margin:0">{{ t('hireTools.title') }}</h1>
      <p class="muted" style="margin: 6px 0 0">
        {{ t('hireTools.subtitle') }}
      </p>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="card" style="text-align: center; padding: 40px">
      <p class="muted">{{ t('hireTools.loading') }}</p>
    </div>

    <!-- Error -->
    <div v-if="error && !saving" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
      <div class="mono" style="color: var(--danger)">{{ error }}</div>
    </div>

    <!-- Toast de éxito -->
    <div v-if="toast" class="card" style="border-color: var(--success); background: color-mix(in oklab, var(--success) 10%, var(--card))">
      <div class="row" style="justify-content: space-between; align-items: center">
        <span style="color: var(--success); font-weight: 600">{{ toast }}</span>
        <button class="btn btn-sm btn-ghost" @click="toast = ''">×</button>
      </div>
    </div>

    <!-- Form -->
    <div class="card">
      <div style="font-weight:650; margin-bottom: 16px">{{ t('hireTools.newProfile') }}</div>

      <div class="form-grid">
        <label>
          <div class="muted text-sm">{{ t('hireTools.firstName') }}</div>
          <input class="input" v-model="form.firstName" placeholder="Ej: Juan" />
        </label>
        <label>
          <div class="muted text-sm">{{ t('hireTools.lastName') }}</div>
          <input class="input" v-model="form.lastName" placeholder="Ej: Pérez" />
        </label>
        <label>
          <div class="muted text-sm">{{ t('hireTools.email') }}</div>
          <input class="input" type="email" v-model="form.email" placeholder="Ej: juan@empresa.com" />
        </label>

        <!-- Department combobox -->
        <label>
          <div class="muted text-sm">{{ t('hireTools.department') }}</div>
          <div class="combobox-wrap">
            <input
              class="input"
              v-model="deptSearch"
              @input="debouncedSearchDepts"
              @focus="deptSearch ? null : searchDepts('')"
              :placeholder="t('hireTools.searchDept')"
            />
            <div v-if="deptResults.length && deptSearch.length > 0" class="combobox-drop">
              <div
                v-for="d in deptResults"
                :key="d.id || d.key"
                class="combobox-item"
                @click="selectDept(d)"
              >
                {{ d.name || d.key || d }}
              </div>
            </div>
          </div>
        </label>

        <!-- Job title combobox -->
        <label>
          <div class="muted text-sm">{{ t('hireTools.jobTitle') }}</div>
          <div class="combobox-wrap">
            <input
              class="input"
              v-model="jobSearch"
              @input="debouncedSearchJobs"
              @focus="jobSearch ? null : searchJobs('')"
              :placeholder="t('hireTools.searchTitle')"
            />
            <div v-if="jobResults.length && jobSearch.length > 0" class="combobox-drop">
              <div
                v-for="j in jobResults"
                :key="j.id || j.key"
                class="combobox-item"
                @click="selectJob(j)"
              >
                {{ j.name || j.title || j.key || j }}
              </div>
            </div>
          </div>
        </label>

        <label>
          <div class="muted text-sm">{{ t('hireTools.costCenter') }}</div>
          <input class="input" v-model="form.costCenter" placeholder="Ej: CC-001" />
        </label>
        <label>
          <div class="muted text-sm">{{ t('hireTools.startDate') }}</div>
          <input class="input" type="date" v-model="form.startDate" />
        </label>
      </div>

      <div class="row" style="gap: 10px; margin-top: 16px">
        <button class="btn btn-primary" :disabled="saving" @click="submitForm">
          {{ saving ? t('hireTools.submitting') : t('hireTools.submit') }}
        </button>
        <button class="btn btn-ghost" type="button" @click="resetForm">{{ t('hireTools.clean') }}</button>
      </div>
    </div>

    <!-- Sección de debug / preview -->
    <details class="card" style="margin-top: 0">
      <summary class="muted">{{ t('hireTools.debug') }}</summary>
      <pre class="pre">{{ pretty(lastResponse) }}</pre>
    </details>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api'

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const toast = ref('')
const lastResponse = ref(null)

const form = ref({
  firstName: '',
  lastName: '',
  email: '',
  costCenter: '',
  startDate: '',
})

// Department combobox
const deptSearch = ref('')
const deptResults = ref([])
const selectedDept = ref(null)
let deptTimer = null

function debouncedSearchDepts() {
  clearTimeout(deptTimer)
  deptTimer = setTimeout(() => searchDepts(deptSearch.value), 250)
}

async function searchDepts(q) {
  try {
    const res = await api(`/departments?q=${encodeURIComponent(q || '')}`)
    deptResults.value = res.items || res || []
  } catch {
    deptResults.value = []
  }
}

function selectDept(d) {
  selectedDept.value = d
  deptSearch.value = d.name || d.key || ''
  deptResults.value = []
}

// Job title combobox
const jobSearch = ref('')
const jobResults = ref([])
const selectedJob = ref(null)
let jobTimer = null

function debouncedSearchJobs() {
  clearTimeout(jobTimer)
  jobTimer = setTimeout(() => searchJobs(jobSearch.value), 250)
}

async function searchJobs(q) {
  try {
    const res = await api(`/job_titles?q=${encodeURIComponent(q || '')}`)
    jobResults.value = res.items || res || []
  } catch {
    jobResults.value = []
  }
}

function selectJob(j) {
  selectedJob.value = j
  jobSearch.value = j.name || j.title || j.key || ''
  jobResults.value = []
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2)
}

function resetForm() {
  form.value = { firstName: '', lastName: '', email: '', costCenter: '', startDate: '' }
  deptSearch.value = ''
  jobSearch.value = ''
  selectedDept.value = null
  selectedJob.value = null
  error.value = ''
}

async function submitForm() {
  error.value = ''
  toast.value = ''
  // Name every missing field instead of the host's first technical message ("departmentId debe…").
  const missing = [
    [form.value.firstName, 'hireTools.firstName'], [form.value.lastName, 'hireTools.lastName'], [form.value.email, 'hireTools.email'],
    [selectedDept.value, 'hireTools.department'], [selectedJob.value, 'hireTools.jobTitle'],
    [form.value.costCenter, 'hireTools.costCenter'], [form.value.startDate, 'hireTools.startDate'],
  ].filter(([value]) => !(typeof value === 'string' ? value.trim() : value)).map(([, key]) => t(key))
  if (missing.length) {
    error.value = `${t('hireTools.missingFields')}: ${missing.join(', ')}`
    return
  }
  saving.value = true
  lastResponse.value = null

  try {
    const payload = {
      firstName: form.value.firstName,
      lastName: form.value.lastName,
      email: form.value.email,
      departmentId: selectedDept.value?.id || selectedDept.value?.key || null,
      jobTitleId: selectedJob.value?.id || selectedJob.value?.key || null,
      costCenter: form.value.costCenter || null,
      startDate: form.value.startDate || null,
    }

    const res = await api('/enterprise/hire-profiles', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    lastResponse.value = res
    toast.value = t('hireTools.success')
    resetForm()
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  searchDepts('').catch(() => {})
  searchJobs('').catch(() => {})
})
</script>

<style scoped>
.stack { display: grid; gap: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.input { width: 100%; border: 1px solid var(--line); background: var(--card); color: inherit; padding: 8px 10px; border-radius: 4px; box-sizing: border-box; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pre { margin: 0; padding: 10px; border: 1px solid var(--line); background: var(--card2); overflow: auto; max-height: 420px; }

/* Combobox */
.combobox-wrap { position: relative; }
.combobox-drop {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  /* --card is translucent; the list must hide the fields underneath, like ComboBox. */
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: none;
  max-height: 200px;
  overflow-y: auto;
}
.combobox-item {
  padding: 8px 10px;
  cursor: pointer;
  font-size: 13px;
}
.combobox-item:hover {
  background: var(--color-surface-hover);
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
