<template>
  <div class="stack">
    <!-- Header -->
    <div class="card-glass stack" style="gap: 12px">
      <div class="row justify-between items-center">
        <div>
          <h2 class="text-lg font-bold" style="margin: 0">{{ t('publish.newTitle') }}</h2>
          <p class="muted text-sm mt-4">{{ t('publish.subtitle') }}</p>
        </div>
        <PlusCircle :size="22" class="muted" />
      </div>
    </div>

    <!-- Plantillas rápidas -->
    <div class="card stack" style="gap: 12px">
      <div class="row items-center gap-8">
        <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('publish.template') }}</span>
        <span class="badge badge-info text-xs">{{ templates.length }} {{ t('publish.available') }}</span>
      </div>
      <div class="template-grid">
        <button
          v-for="t in templates"
          :key="t.title"
          class="template-card"
          :class="{ selected: selectedTemplate?.title === t.title }"
          @click="selectTemplate(t)"
        >
          <div class="template-header">
            <span class="template-title">{{ t.title }}</span>
            <span class="badge" :class="kindBadge(t.kind)">
              {{ t.kind }}
            </span>
          </div>
          <div class="template-meta">
            <span class="text-xs muted">{{ t.location }}</span>
            <span class="text-xs muted">{{ t.pay }}</span>
          </div>
          <div class="template-tags">
            <span v-for="tag in t.tagsList" :key="tag" class="badge badge-neutral text-xs">{{ tag }}</span>
          </div>
        </button>
      </div>
      <div class="row justify-between items-center">
        <span class="text-sm muted" v-if="!selectedTemplate">{{ t('publish.selectTemplate') }}</span>
        <button
          v-else
          class="btn btn-secondary btn-sm"
          @click="applyTemplate"
        >
          {{ t('publish.useTemplate') }}: {{ selectedTemplate.title }}
        </button>
      </div>
    </div>

    <!-- Tus plantillas guardadas -->
    <div class="card stack" style="gap: 12px" v-if="savedTemplates.length > 0">
      <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('publish.yourTemplates') }}</span>
      <div class="stack gap-8">
        <div
          v-for="st in savedTemplates"
          :key="st.title"
          class="row justify-between items-center card card-sm"
          style="cursor: pointer"
          @click="applySavedTemplate(st)"
        >
          <div class="row items-center gap-8">
            <span class="font-semibold text-sm">{{ st.title }}</span>
            <span class="badge text-xs" :class="kindBadge(st.kind)">{{ st.kind }}</span>
          </div>
          <button class="btn btn-ghost btn-sm" @click.stop="deleteSavedTemplate(st)">
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- Form -->
    <form class="card stack" style="gap: 16px" @submit.prevent="onSubmit">
      <!-- Tipo -->
      <div class="row items-center gap-8">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase">{{ t('publish.type') }}</label>
        <div class="row gap-8 flex-1">
          <select class="select flex-1" v-model="form.kind">
            <option value="empleo">{{ t('search.employment') }}</option>
            <option value="ett">{{ t('search.ett') }}</option>
            <option value="becario">{{ t('search.intern') }}</option>
          </select>
          <Briefcase :size="16" class="muted flex-shrink-0" style="opacity: 0.4" />
        </div>
      </div>

      <!-- Título -->
      <div class="row items-center gap-8">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase">{{ t('publish.titleField') }}</label>
        <div class="row gap-8 flex-1">
          <input class="input flex-1" v-model="form.title" placeholder="p.ej. Desarrollador Vue" required />
          <FileText :size="16" class="muted flex-shrink-0" style="opacity: 0.4" />
        </div>
      </div>

      <!-- Empresa -->
      <div class="row items-center gap-8">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase">{{ t('publish.company') }}</label>
        <input class="input flex-1" v-model="form.company" placeholder="Nombre de la empresa" />
      </div>

      <!-- Ubicación -->
      <div class="row items-center gap-8">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase">{{ t('publish.location') }}</label>
        <div class="row gap-8 flex-1">
          <input class="input flex-1" v-model="form.location" placeholder="Ciudad / remoto" />
          <MapPin :size="16" class="muted flex-shrink-0" style="opacity: 0.4" />
        </div>
      </div>

      <!-- Salario -->
      <div class="row items-center gap-8">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase">{{ t('publish.salary') }}</label>
        <div class="row gap-8 flex-1">
          <input class="input flex-1" v-model="form.pay" placeholder="p.ej. 45–60k / 2–4k" />
          <DollarSign :size="16" class="muted flex-shrink-0" style="opacity: 0.4" />
        </div>
      </div>

      <!-- Tags -->
      <div class="row items-center gap-8">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase">{{ t('publish.tags') }}</label>
        <div class="row gap-8 flex-1">
          <input class="input flex-1" v-model="form.tags" placeholder="vue, js, remoto" />
          <Tag :size="16" class="muted flex-shrink-0" style="opacity: 0.4" />
        </div>
      </div>

      <!-- Descripción -->
      <div class="row gap-8" style="align-items: flex-start">
        <label class="muted text-sm font-semibold" style="width: 90px; text-transform: uppercase; padding-top: 10px">{{ t('publish.description') }}</label>
        <textarea class="textarea flex-1" rows="7" v-model="form.desc" placeholder="Describe la oferta, requisitos, beneficios…" />
      </div>

      <!-- Actions -->
      <div class="row justify-between items-center">
        <span class="muted text-sm">{{ t('publish.tip') }}</span>
        <button class="btn btn-primary" type="submit">
          <PlusCircle :size="16" />
          {{ t('publish.publishBtn') }}
        </button>
      </div>
    </form>

    <!-- Published listings -->
    <div v-if="companyListings.length" class="stack mt-8">
      <div class="divider" />
      <div class="row justify-between items-center">
        <div class="font-semibold text-sm muted" style="text-transform: uppercase">{{ t('publish.published') }}</div>
        <span class="badge">{{ companyListings.length }}</span>
      </div>

      <div class="stack gap-8">
        <div v-for="l in companyListings" :key="l.id" class="card card-sm" @click="app.openDrawer(l.id)" style="cursor: pointer">
          <div class="row justify-between items-center">
            <div class="stack gap-4">
              <div class="row items-center gap-8">
                <span class="font-semibold">{{ l.title }}</span>
                <span class="badge">{{ l.kind }}</span>
              </div>
              <div class="row gap-12 muted text-sm">
                <span v-if="l.company" class="row items-center gap-4">
                  <Briefcase :size="12" />
                  {{ l.company }}
                </span>
                <span v-if="l.location" class="row items-center gap-4">
                  <MapPin :size="12" />
                  {{ l.location }}
                </span>
                <span v-if="l.pay" class="row items-center gap-4">
                  <DollarSign :size="12" />
                  {{ l.pay }}
                </span>
              </div>
            </div>
            <span class="text-sm muted">{{ l.created?.slice(0, 10) || '—' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { t } from '../lib/i18n.js'
import { PlusCircle, Briefcase, MapPin, DollarSign, Tag, FileText, Trash2 } from 'lucide-vue-next'

const app = useAppStore()
app.bootstrap()

const router = useRouter()

const form = reactive({
  kind: 'empleo',
  title: '',
  company: '',
  location: '',
  pay: '',
  tags: '',
  desc: '',
})

// ===== Plantillas predefinidas =====
const templates = [
  {
    title: 'Full-Stack Developer',
    kind: 'empleo',
    location: 'Remoto',
    pay: '50-70K',
    tags: 'React, Node, TypeScript',
    tagsList: ['React', 'Node', 'TypeScript'],
    desc: 'Buscamos un Full-Stack Developer con experiencia en React, Node.js y TypeScript para unirse a nuestro equipo de producto.',
  },
  {
    title: 'DevOps Engineer',
    kind: 'empleo',
    location: 'Remoto',
    pay: '60-85K',
    tags: 'AWS, K8s, Docker',
    tagsList: ['AWS', 'K8s', 'Docker'],
    desc: 'DevOps Engineer con experiencia en cloud (AWS), Kubernetes y Docker. Responsable de CI/CD y monitoreo de infraestructura.',
  },
  {
    title: 'UX Designer',
    kind: 'empleo',
    location: 'Barcelona',
    pay: '40-55K',
    tags: 'Figma, Research',
    tagsList: ['Figma', 'Research'],
    desc: 'UX Designer con experiencia en Figma y user research. Trabajarás en productos digitales con foco en accesibilidad.',
  },
  {
    title: 'Project Manager',
    kind: 'ett',
    location: 'Madrid',
    pay: '45-60K',
    tags: 'Agile, Scrum',
    tagsList: ['Figma', 'Research'],
    desc: 'Project Manager con experiencia en metodologías ágiles y Scrum. Gestión de proyectos IT de alto impacto.',
  },
  {
    title: 'Becario Investigación',
    kind: 'becario',
    location: 'Madrid',
    pay: '12-18K',
    tags: 'Biotecnología, Laboratorio, Pharmamar',
    tagsList: ['Biotecnología', 'Laboratorio', 'Pharmamar'],
    desc: 'Becario de investigación en el departamento de I+D de Pharmamar.',
  },
]

const selectedTemplate = ref(null)

function selectTemplate(t) {
  selectedTemplate.value = t
}

function applyTemplate() {
  if (!selectedTemplate.value) return
  const t = selectedTemplate.value
  form.kind = t.kind
  form.title = t.title
  form.location = t.location
  form.pay = t.pay
  form.tags = t.tags
  form.desc = t.desc
}

// ===== Plantillas guardadas (localStorage) =====
const SAVED_KEY = 'proyecto_x_saved_templates'

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')
  } catch {
    return []
  }
}

function persistSaved(arr) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(arr))
}

const savedTemplates = ref(loadSaved())

function saveCurrentAsTemplate() {
  // No implementation — just a note that storage is available.
  // Users can save via a future "Guardar como plantilla" button if needed.
}

function applySavedTemplate(st) {
  form.kind = st.kind
  form.title = st.title
  form.location = st.location
  form.pay = st.pay
  form.tags = st.tags
  form.desc = st.desc
}

function deleteSavedTemplate(st) {
  savedTemplates.value = savedTemplates.value.filter((s) => s.title !== st.title)
  persistSaved(savedTemplates.value)
}

// ===== Listings & submit =====
const companyListings = computed(() => (app.state.listings || []).filter((l) => l.kind === 'empleo' || l.kind === 'ett' || l.kind === 'becario'))

async function onSubmit() {
  let l
  try {
    l = await app.createListingServer(form)
  } catch {
    app.toast = { kind: 'info', text: t('publish.publishError') }
    return
  }

  await app.refreshListingsFromServer().catch(() => {})

  router.push('/buscar')
app.openDrawer(l.id)

// Guardar como plantilla inteligente (basada en últimas ofertas)
try {
  const saved = JSON.parse(localStorage.getItem('px_published_templates') || '[]')
  saved.unshift({ kind: form.kind, title: form.title, location: form.location, pay: form.pay, tags: form.tags, desc: form.desc })
  if (saved.length > 5) saved.length = 5
  localStorage.setItem('px_published_templates', JSON.stringify(saved))
} catch {}
}

function kindBadge(k) {
if (k === 'empleo') return 'badge-info'
if (k === 'ett') return 'badge-warning'
if (k === 'becario') return 'badge-success'
return 'badge-neutral'
}
</script>

<style scoped>
.template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}

.template-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface);
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
  color: inherit;
  font-family: inherit;
}

.template-card:hover {
  border-color: var(--color-accent);
  background: var(--color-surface-hover);
}

.template-card.selected {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
  box-shadow: 0 0 0 1px var(--color-accent);
}

.template-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.template-title {
  font-weight: 600;
  font-size: 14px;
  line-height: 1.3;
}

.template-meta {
  display: flex;
  gap: 12px;
}

.template-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
