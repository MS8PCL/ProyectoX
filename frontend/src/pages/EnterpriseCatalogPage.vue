<template>
  <div class="stack">
    <header class="row" style="justify-content: space-between; align-items: end">
      <div>
        <h1 style="margin: 0">Catálogo (enterprise)</h1>
        <p class="muted" style="margin: 6px 0 0">Master data versionado (vista mínima). Edición avanzada: pendiente.</p>
      </div>

      <div class="row" style="gap: 10px">
        <label class="muted">Tipo</label>
        <select class="input" v-model="type">
          <option value="department">Departments</option>
          <option value="job_title">Job Titles</option>
          <option value="cost_center">Cost Centers</option>
          <option value="access_profile">Access Profiles</option>
          <option value="hardware_profile">Hardware Profiles</option>
        </select>
        <button class="btn" @click="load">Recargar</button>
      </div>
    </header>

    <div class="card">
      <div class="row" style="justify-content: space-between">
        <span class="muted">Items</span>
        <span class="kbd">{{ items.length }}</span>
      </div>

      <div style="margin-top: 10px" class="table">
        <div class="thead">
          <div>Key</div>
          <div>Status</div>
          <div>ID</div>
        </div>
        <div v-for="it in items" :key="it.id" class="trow">
          <div class="mono">{{ it.key }}</div>
          <div class="mono">{{ it.status }}</div>
          <div class="mono muted">{{ it.id }}</div>
        </div>
      </div>
    </div>

    <div v-if="error" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
      <div class="mono">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../lib/api'

const type = ref('department')
const items = ref([])
const error = ref('')

async function load() {
  error.value = ''
  try {
    const res = await api(`/enterprise/catalog/items?type=${encodeURIComponent(type.value)}`)
    items.value = res.items || []
  } catch (e) {
    error.value = String(e?.message || e)
  }
}

onMounted(load)
</script>

<style scoped>
.stack { display: grid; gap: 16px; }
.input { border: 1px solid var(--line); background: var(--card); color: inherit; padding: 8px 10px; }
.table { display: grid; gap: 6px; }
.thead, .trow { display: grid; grid-template-columns: 1.5fr 1fr 2fr; gap: 10px; }
.thead { font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.trow { border: 1px solid var(--line); padding: 10px; background: var(--card2); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
