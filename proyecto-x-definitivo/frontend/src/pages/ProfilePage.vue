<template>
  <div class="stack">
    <!-- Banner de onboarding si es nuevo usuario -->
    <div v-if="isOnboarding" class="card onboardingBanner">
      <div style="font-weight: 650; margin-bottom: 8px">Bienvenido a Proyecto X</div>
      <div class="muted" style="font-size: 12px">
        Completa tu perfil para empezar. Los campos marcados con <span class="kbd">*</span> son obligatorios.
      </div>
    </div>
    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <div>
          <div style="font-weight: 650">Perfil — {{ app.role }}</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">Completa tu perfil. Se guarda en tu cuenta.</div>
        </div>
        <button class="btn" @click="copy">Copiar perfil</button>
      </div>
    </div>

    <form class="card stack" @submit.prevent="save">
      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Nombre <span class="kbd">*</span></label>
        <input class="input" v-model="form.name" :placeholder="app.role === 'empresa' ? 'Nombre de la empresa' : 'Nombre y apellidos'" required />
      </div>
      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Título <span class="kbd">*</span></label>
        <input class="input" v-model="form.title" :placeholder="app.role === 'empresa' ? 'Sector' : 'Título profesional'" required />
      </div>
      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Lugar <span class="kbd">*</span></label>
        <input class="input" v-model="form.location" :placeholder="app.role === 'empresa' ? 'Ciudad' : 'Ciudad / remoto'" required />
      </div>
      <div v-if="app.role !== 'empresa'" class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Skills</label>
        <input class="input" v-model="form.skills" placeholder="vue, js, producto" />
      </div>
      <div class="row" style="gap: 8px; align-items: flex-start">
        <label class="muted" style="width: 90px; padding-top: 10px">About</label>
        <textarea class="textarea" rows="6" v-model="form.about" :placeholder="app.role === 'empresa' ? 'Qué hacéis, qué buscáis, cómo es el proceso…' : 'Qué haces, qué buscas, disponibilidad, enlaces…'" />
      </div>

      <div v-if="app.role !== 'empresa'" class="row" style="justify-content: space-between; align-items: center">
        <div>
          <div class="muted" style="font-size: 12px">Visibilidad</div>
          <div class="muted" style="font-size: 12px; margin-top: 4px">En privado: tu perfil no es visible públicamente. Si aplicas o una empresa te guarda, podrá ver tu info.</div>
        </div>
        <label class="row" style="gap: 10px; align-items: center">
          <span class="kbd">{{ form.public ? 'Público' : 'Privado' }}</span>
          <input type="checkbox" v-model="form.public" />
        </label>
      </div>

      <div class="row" style="justify-content: space-between">
        <div class="muted" style="font-size: 12px">Campos obligatorios: Nombre y Título.</div>
        <button class="btn primary" type="submit">{{ isOnboarding ? 'Continuar' : 'Guardar' }}</button>
      </div>
    </form>

    <div v-if="app.role !== 'empresa'" class="card stack">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <div>
          <div style="font-weight: 650">Importar perfil</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            LinkedIn (PDF), CV (PDF) y enlaces (portfolio/Behance/Dribbble). Se guarda en PocketBase.
          </div>
        </div>
      </div>

      <div class="row" style="gap: 8px">
        <select class="select" v-model="docType" style="width: 180px">
          <option value="cv">CV</option>
          <option value="certificate">Certificado</option>
          <option value="portfolio">Portfolio</option>
          <option value="linkedin">LinkedIn (PDF)</option>
          <option value="other">Otros</option>
        </select>
        <input class="input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" @change="onPickDoc" />
        <button class="btn" type="button" @click="uploadDoc" :disabled="uploading || !pickedDoc">Subir</button>
      </div>

      <div class="row" style="gap: 8px">
        <select class="select" v-model="link.kind" style="width: 160px">
          <option value="portfolio">Portfolio</option>
          <option value="behance">Behance</option>
          <option value="dribbble">Dribbble</option>
        </select>
        <input class="input" v-model="link.url" placeholder="https://…" />
        <button class="btn" type="button" @click="addLink" :disabled="uploading || !link.url">Añadir enlace</button>
      </div>

      <div v-if="err" class="muted" style="font-size: 12px; color: color-mix(in oklab, var(--danger) 70%, var(--ink))">
        {{ err }}
      </div>

      <div class="stack" style="margin-top: 10px">
        <div class="muted" style="font-size: 12px">Importaciones</div>
        <div v-for="it in imports" :key="it.id" class="row" style="justify-content: space-between">
          <div>
            <div style="font-weight: 650">
              {{ it.kind === 'document' ? (it.docType || 'documento') : it.kind }}
            </div>
            <div class="muted" style="font-size: 12px">{{ it.url || (it.file ? 'archivo' : '') }}</div>
          </div>
          <span class="kbd">{{ it.created?.slice(0,10) }}</span>
        </div>
        <div v-if="!imports.length" class="muted" style="font-size: 12px">(vacío)</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, apiForm } from '../lib/api.js'
import { useAppStore } from '../stores/app.js'

const route = useRoute()
const router = useRouter()

const app = useAppStore()
app.bootstrap()

const isOnboarding = computed(() => route.query.onboarding === '1')

const p = computed(() => app.state?.profile?.[app.role] || null)

const form = reactive({ name: '', title: '', location: '', skills: '', about: '', public: true })

// Prefer server profile (PocketBase source of truth)
async function loadServerProfile() {
  try {
    const res = await api('/profile')
    const prof = res?.profile || null
    if (!prof) return

    if (app.role === 'empresa') {
      form.name = prof.companyName || form.name
      form.title = prof.sector || form.title
      form.location = prof.location || form.location
    } else {
      form.name = prof.fullName || form.name
      form.title = prof.title || form.title
      form.location = prof.location || form.location
      form.public = prof.public !== false
      form.skills = Array.isArray(prof.skills) ? prof.skills.join(', ') : form.skills
      form.about = prof.about || form.about
    }
  } catch {
     //ignore
     console.warn("There was an error")
  }
}

const imports = ref([])
const uploading = ref(false)
const err = ref('')
const docType = ref('cv')
const pickedDoc = ref(null)
const link = reactive({ kind: 'portfolio', url: '' }) //Reactive?

watch(
  p,
  (x) => {
    form.name = x?.name || ''
    form.title = x?.title || ''
    form.location = x?.location || ''
    form.skills = app.role === 'empresa' ? '' : Array.isArray(x?.skills) ? x.skills.join(', ') : ''
    form.about = x?.about || ''
    form.public = x?.public !== false
  },
  { immediate: true }
)

async function loadImports() {
  if (app.role === 'empresa') return
  try {
    const res = await api('/profile/imports')
    imports.value = res.items || []
  } catch {
    // ignore
  }
}

loadImports()
loadServerProfile()

function onPickDoc(e) {
  const file = e?.target?.files?.[0]
  if (!file) return
  pickedDoc.value = file
}

async function uploadDoc() {
  err.value = ''
  uploading.value = true
  try {
    const f = pickedDoc.value
    const fd = new FormData()
    fd.set('docType', docType.value)
    fd.set('file', f)
    const res = await apiForm('/profile/imports/file', fd)
    pickedDoc.value = null
    await loadImports()

    // If the user uploaded a CV, store a direct URL for the company-side preview.
    if (docType.value === 'cv' && res?.item?.id) {
      const pb = 'http://localhost:8090'
      const f = res?.item?.file
      const filename = Array.isArray(f) ? f[0] : typeof f === 'string' ? f : ''
      if (filename) {
        const url = `${pb}/api/files/profile_imports/${encodeURIComponent(res.item.id)}/${encodeURIComponent(filename)}`
        app.setCandidateCvUrl('cand_me', url)
      }
    }
  } catch (e) {
    err.value = e?.message || String(e)
  } finally {
    uploading.value = false
  }
}

async function addLink() {
  err.value = ''
  uploading.value = true
  try {
    await api('/profile/imports/link', { method: 'POST', body: JSON.stringify({ kind: link.kind, url: link.url }) })
    link.url = ''
    await loadImports()
  } catch (e) {
    err.value = e?.message || String(e)
  } finally {
    uploading.value = false
  }
}

async function save() {
  const name = String(form.name || '').trim()
  const title = String(form.title || '').trim()
  const location = String(form.location || '').trim()

  if (name.length < 2 || title.length < 2 || location.length < 2) {
    app.toast = { kind: 'info', text: 'Nombre, Título/Sector y Lugar son obligatorios (mínimo 2 caracteres).' }
    return
  }

  // Persist locally (state)
  app.updateProfile(app.role, {
    name,
    title,
    location,
    skills: app.role === 'empresa' ? [] : form.skills.split(',').map((s) => s.trim()).filter(Boolean),
    about: form.about,
    public: app.role === 'empresa' ? true : !!form.public,
  })

  // Persist in PocketBase via API (server-side source of truth)
  try {
    if (app.role === 'empresa') {
      await api('/profile', {
        method: 'PUT',
        body: JSON.stringify({ companyName: name, sector: title, location }),
      })
    } else {
      await api('/profile', {
        method: 'PUT',
        body: JSON.stringify({
          fullName: name,
          title,
          location,
          public: !!form.public,
          skills: form.skills.split(',').map((s) => s.trim()).filter(Boolean),
          about: form.about,
        }),
      })
    }
  } catch (e) {
    app.toast = { kind: 'info', text: `No se pudo guardar en servidor: ${e?.message || e}` }
    return
  }

  app.toast = { kind: 'ok', text: 'Perfil guardado.' }

  if (isOnboarding.value) {
    const next = typeof route.query.next === 'string' ? route.query.next : '/'
    await router.replace(next)
  }
}

async function copy() {
  const text = JSON.stringify(app.state.profile[app.role], null, 2)
  await navigator.clipboard.writeText(text)
  app.toast = { kind: 'ok', text: 'Perfil copiado al portapapeles.' }
}
</script>

<style scoped>
.onboardingBanner {
  border-color: var(--line2);
  background: color-mix(in oklab, var(--card) 85%, var(--bg));
}
</style>
