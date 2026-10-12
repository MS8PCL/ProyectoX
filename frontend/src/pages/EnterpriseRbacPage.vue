<template>
  <div class="stack">
    <header class="row" style="justify-content: space-between; align-items: end">
      <div>
        <h1 style="margin: 0">{{ t('rbac.title') }}</h1>
        <p class="muted" style="margin: 6px 0 0">{{ t('rbac.subtitle') }}</p>
      </div>
      <button class="btn" @click="load" :disabled="loading">{{ t('rbac.reload') }}</button>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="card" style="text-align: center; padding: 40px">
      <p class="muted">{{ t('rbac.loadingRules') }}</p>
    </div>

    <!-- Error -->
    <div v-if="error && !loading" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
      <div class="mono" style="color: var(--danger)">{{ error }}</div>
    </div>

    <!-- Empty state -->
    <div v-if="!loading && !error && rules.length === 0" class="card" style="text-align: center; padding: 40px">
      <p class="muted" style="margin-bottom: 16px">{{ t('rbac.empty') }}</p>
      <RouterLink class="btn btn-primary btn-sm" to="/enterprise/rbac">{{ t('rbac.createFirst') }}</RouterLink>
    </div>

    <!-- Rules list -->
    <div v-if="!loading && rules.length > 0" class="card">
      <div class="row" style="justify-content: space-between">
        <span class="muted">{{ t('rbac.rules') }}</span>
        <span class="kbd">{{ rules.length }}</span>
      </div>

      <div class="list" style="margin-top: 10px">
        <div v-for="r in rules" :key="r.id" class="rule">
          <div class="row" style="justify-content: space-between">
            <div>
              <div style="font-weight: 650">{{ r.name }}</div>
              <div class="muted mono">prio={{ r.priority }} · status={{ r.status }}</div>
            </div>
            <div class="mono muted">{{ r.id }}</div>
          </div>
          <details style="margin-top: 10px">
            <summary class="muted">Condition / Result</summary>
            <pre class="pre">{{ pretty({ condition: r.condition, result_access_profiles: r.result_access_profiles }) }}</pre>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api'

const rules = ref([])
const loading = ref(false)
const error = ref('')

function pretty(obj) {
  return JSON.stringify(obj, null, 2)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await api('/enterprise/rbac/rules')
    rules.value = res.items || []
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.stack { display: grid; gap: 16px; }
.list { display: grid; gap: 10px; }
.rule { border: 1px solid var(--line); background: var(--card2); padding: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pre { margin: 10px 0 0; padding: 10px; border: 1px solid var(--line); background: var(--card); overflow: auto; }
</style>
