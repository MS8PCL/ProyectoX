<template>
  <div class="stack">
    <!-- Onboarding banner -->
    <div v-if="isOnboarding" class="card-glass stack" style="gap: 8px">
      <div class="row items-center gap-8">
        <User :size="20" class="muted" />
        <h2 class="text-lg font-bold" style="margin: 0">{{ t('profile.onboardingWelcome') }}</h2>
      </div>
      <p class="muted text-sm">
        {{ t('profile.onboardingDesc') }}
      </p>
    </div>

    <!-- Header -->
    <div class="card-glass stack" style="gap: 12px">
      <div class="row justify-between items-center">
        <div>
          <div class="row items-center gap-8">
            <h2 class="text-lg font-bold" style="margin: 0">{{ t('profile.title') }}</h2>
            <span class="badge">{{ app.role }}</span>
          </div>
          <p class="muted text-sm mt-4">{{ t('profile.subtitle') }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" @click="copy">
          <Copy :size="14" />
          {{ t('profile.copyProfile') }}
        </button>
      </div>
    </div>

    <!-- Form -->
    <form class="card stack" style="gap: 20px" @submit.prevent="save">
      <!-- Sección: Información básica -->
      <div class="stack gap-12">
        <div class="row items-center gap-8">
          <div class="divider" style="flex: 1" />
          <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('profile.basicInfo') }}</span>
          <div class="divider" style="flex: 1" />
        </div>

        <div class="row items-center gap-8">
          <label class="muted text-sm font-semibold" style="width: 90px">
            {{ t('profile.name') }} <span class="kbd">*</span>
          </label>
          <input
            class="input flex-1"
            v-model="form.name"
            :placeholder="app.role === 'empresa' ? t('profile.namePlaceholderEmp') : t('profile.namePlaceholderCand')"
            required
          />
        </div>

        <div class="row items-center gap-8">
          <label class="muted text-sm font-semibold" style="width: 90px">
            {{ t('profile.titleField') }} <span class="kbd">*</span>
          </label>
          <input
            class="input flex-1"
            v-model="form.title"
            :placeholder="app.role === 'empresa' ? t('profile.titlePlaceholderEmp') : t('profile.titlePlaceholderCand')"
            required
          />
        </div>

        <div class="row items-center gap-8">
          <label class="muted text-sm font-semibold" style="width: 90px">
            {{ t('profile.location') }} <span class="kbd">*</span>
          </label>
          <input
            class="input flex-1"
            v-model="form.location"
            :placeholder="app.role === 'empresa' ? t('profile.locationPlaceholderEmp') : t('profile.locationPlaceholderCand')"
            required
          />
        </div>
      </div>

      <!-- Sección: Detalles (solo no-empresa) -->
      <div v-if="app.role !== 'empresa'" class="stack gap-12">
        <div class="row items-center gap-8">
          <div class="divider" style="flex: 1" />
          <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('profile.details') }}</span>
          <div class="divider" style="flex: 1" />
        </div>

        <div class="row items-center gap-8">
          <label class="muted text-sm font-semibold" style="width: 90px">{{ t('profile.skills') }}</label>
          <input
            class="input flex-1"
            v-model="form.skills"
            :placeholder="t('profile.skillsPlaceholder')"
          />
        </div>

        <div class="row gap-8" style="align-items: flex-start">
          <label class="muted text-sm font-semibold" style="width: 90px; padding-top: 10px">{{ t('profile.about') }}</label>
          <textarea
            class="textarea flex-1"
            rows="6"
            v-model="form.about"
            :placeholder="app.role === 'empresa' ? t('profile.aboutPlaceholderEmp') : t('profile.aboutPlaceholderCand')"
          />
        </div>
      </div>

      <!-- Sección: Visibilidad (solo no-empresa) -->
      <div v-if="app.role !== 'empresa'" class="stack gap-12">
        <div class="row items-center gap-8">
          <div class="divider" style="flex: 1" />
          <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('profile.visibility') }}</span>
          <div class="divider" style="flex: 1" />
        </div>

        <div class="row justify-between items-center">
          <div class="stack gap-4">
            <div class="font-semibold text-sm">{{ form.public ? t('profile.public') : t('profile.private') }}</div>
            <div class="muted text-sm">
              {{ t('profile.privateDesc') }}
            </div>
          </div>
          <label class="row items-center gap-8 cursor-pointer">
            <component :is="form.public ? Globe : Lock" :size="18" class="muted" />
            <input type="checkbox" v-model="form.public" style="accent-color: var(--color-accent)" />
          </label>
        </div>
      </div>

      <!-- Sección: Documentos y enlaces (solo no-empresa) -->
      <div v-if="app.role !== 'empresa'" class="stack gap-12">
        <div class="row items-center gap-8">
          <div class="divider" style="flex: 1" />
          <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('profile.documents') }}</span>
          <div class="divider" style="flex: 1" />
        </div>

        <div class="stack gap-8">
          <div class="font-semibold text-sm">{{ t('profile.importProfile') }}</div>
          <p class="muted text-sm">
            {{ t('profile.importDesc') }}
          </p>
        </div>

        <div class="row gap-8 items-center flex-wrap">
          <select class="select" v-model="docType" style="width: 180px">
            <option value="cv">CV</option>
            <option value="certificate">Certificado</option>
            <option value="portfolio">Portfolio</option>
            <option value="linkedin">LinkedIn (PDF)</option>
            <option value="other">Otros</option>
          </select>
          <input class="input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" @change="onPickDoc" />
          <button class="btn btn-primary btn-sm" type="button" @click="uploadDoc" :disabled="uploading || !pickedDoc">
            <Upload :size="14" />
            {{ t('profile.upload') }}
          </button>
        </div>

        <div class="row gap-8 items-center flex-wrap">
          <select class="select" v-model="link.kind" style="width: 160px">
            <option value="portfolio">Portfolio</option>
            <option value="behance">Behance</option>
            <option value="dribbble">Dribbble</option>
          </select>
          <input class="input" v-model="link.url" placeholder="https://…" />
          <button class="btn btn-ghost btn-sm" type="button" @click="addLink" :disabled="uploading || !link.url">
            <LinkIcon :size="14" />
            {{ t('profile.addLink') }}
          </button>
        </div>

        <div v-if="err" class="text-sm" style="color: var(--color-danger)">
          {{ err }}
        </div>

        <div class="stack gap-8 mt-8">
          <div class="font-semibold text-sm">{{ t('profile.imports') }}</div>
          <div v-if="imports.length" class="stack gap-8">
            <div v-for="it in imports" :key="it.id" class="row justify-between items-center">
              <div>
                <div class="font-semibold text-sm">
                  {{ it.kind === 'document' ? (it.docType || t('profile.document')) : it.kind }}
                </div>
                <div class="muted text-sm">{{ it.url || (it.file ? t('profile.file') : '') }}</div>
              </div>
              <div class="row items-center gap-8">
                              <button v-if="isDesktop() && it.documentId" class="btn btn-ghost btn-sm" type="button" @click="openImport(it)">Abrir</button>
                              <span class="kbd">{{ it.created?.slice(0, 10) }}</span>
                            </div>
            </div>
          </div>
          <div v-else class="muted text-sm">{{ t('profile.emptyImports') }}</div>
        </div>
      </div>

      <!-- Sección: Parsear CV (solo candidatos) -->
      <div class="stack gap-12">
        <div class="row items-center gap-8">
          <div class="divider" style="flex: 1" />
          <span class="muted text-sm font-semibold" style="text-transform: uppercase">{{ t('profile.parseSection') }}</span>
          <div class="divider" style="flex: 1" />
        </div>

        <div class="stack gap-8">
          <p class="muted text-sm">
            {{ t('profile.parseDesc') }}
          </p>

          <div class="row gap-8 items-center flex-wrap">
            <input
              class="input"
              type="file"
              accept=".pdf,.docx,.doc"
              @change="onPickCv"
              style="flex: 1; min-width: 200px"
            />
            <button
              class="btn btn-primary btn-sm"
              type="button"
              @click="analyzeCv"
              :disabled="parsing || !cvFile"
            >
              <Loader v-if="parsing" :size="14" class="spin" />
              <FileSearch v-else :size="14" />
              {{ parsing ? t('profile.analyzing') : t('profile.analyzeBtn') }}
            </button>
          </div>

          <div v-if="parseError" class="text-sm" style="color: var(--color-danger)">
            {{ parseError }}
          </div>

          <div v-if="parseResult && !parsing" class="stack gap-12 mt-8">
            <div v-if="parseResult.name" class="card-inset row justify-between items-center">
              <div class="stack gap-2">
                <span class="muted text-sm">{{ t('profile.parsedName') }}</span>
                <span class="font-semibold">{{ parseResult.name }}</span>
              </div>
              <button class="btn btn-sm btn-ghost" type="button" @click="useName">
                <Check :size="14" />
                {{ t('profile.use') }}
              </button>
            </div>

            <div v-if="parseResult.email" class="card-inset row justify-between items-center">
              <div class="stack gap-2">
                <span class="muted text-sm">{{ t('profile.parsedEmail') }}</span>
                <span class="font-semibold">{{ parseResult.email }}</span>
              </div>
              <button class="btn btn-sm btn-ghost" type="button" @click="useEmail">
                <Mail :size="14" />
                {{ t('profile.copy') }}
              </button>
            </div>

            <div v-if="parseResult.phone" class="card-inset row justify-between items-center">
              <div class="stack gap-2">
                <span class="muted text-sm">{{ t('profile.parsedPhone') }}</span>
                <span class="font-semibold">{{ parseResult.phone }}</span>
              </div>
              <Phone :size="16" class="muted" />
            </div>

            <div v-if="parseResult.skills.length" class="card-inset stack gap-8">
              <div class="row justify-between items-center">
                <span class="muted text-sm">{{ t('profile.parsedSkills') }}</span>
                <button class="btn btn-sm btn-ghost" type="button" @click="addAllSkills">
                  <Plus :size="14" />
                  {{ t('profile.useAll') }}
                </button>
              </div>
              <div class="row gap-6 flex-wrap">
                <span v-for="s in parseResult.skills" :key="s" class="chip">{{ s }}</span>
              </div>
            </div>

            <div class="card-inset stack gap-8">
              <button
                class="btn btn-ghost btn-sm row items-center gap-4"
                type="button"
                style="align-self: flex-start"
                @click="showPreview = !showPreview"
              >
                <component :is="showPreview ? ChevronDown : ChevronRight" :size="14" />
                {{ t('profile.preview') }}
              </button>
              <pre v-if="showPreview" class="text-sm muted" style="white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; margin: 0">{{ parseResult.text }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- Submit -->
      <div class="row justify-between items-center mt-8">
        <span class="faint text-sm">{{ t('profile.requiredFields') }}</span>
        <button class="btn btn-primary" type="submit">
          <Save :size="16" />
          {{ isOnboarding ? t('profile.continue') : t('profile.save') }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, apiForm, desktopRequest, isDesktop } from '../lib/api.js'
import { useAppStore } from '../stores/app.js'
import { useAuthStore } from '../stores/auth.js'
import { t } from '../lib/i18n.js'
import { User, Copy, Upload, Link as LinkIcon, Globe, Lock, Save, FileSearch, ChevronDown, ChevronRight, Loader, Check, Plus, Phone, Mail } from 'lucide-vue-next'
import { parseDocument, extractSkills, extractName, extractEmail, extractPhone } from '../lib/documentParser.js'

const route = useRoute()
const router = useRouter()

const app = useAppStore()
app.bootstrap()

const isOnboarding = computed(() => route.query.onboarding === '1')

const p = computed(() => app.state?.profile?.[app.role] || null)

const form = reactive({ name: '', title: '', location: '', skills: '', about: '', public: true })

// Staff see the "empresa" layout, but both hosts store a company profile only for the
// company role; rrhh/it/admin keep a personal one (fullName/title/location).
const auth = useAuthStore()
const serverCompanyProfile = () => auth.user?.role === 'company'

async function loadServerProfile() {
  try {
    const res = await api('/profile')
    const prof = res?.profile || null
    if (!prof) return

    if (serverCompanyProfile()) {
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
  }
}

const imports = ref([])
const uploading = ref(false)
const err = ref('')
const docType = ref('cv')
const pickedDoc = ref(null)
const link = reactive({ kind: 'portfolio', url: '' })

const cvFile = ref(null)
const parsing = ref(false)
const parseResult = ref(null)
const parseError = ref('')
const showPreview = ref(false)

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
  }
}

loadImports()
loadServerProfile()

async function openImport(item) {
  err.value = ''
  try {
    await desktopRequest('documentAction', { path: `/documents/${encodeURIComponent(item.documentId)}`, action: 'open' })
  } catch (e) {
    err.value = e?.message || String(e)
  }
}

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

    if (docType.value === 'cv' && res?.item?.id) {
      const pb = 'http://localhost:8090'
      const f = res?.item?.file
      const filename = Array.isArray(f) ? f[0] : typeof f === 'string' ? f : ''
      if (filename) {
        const url = isDesktop()
                  ? res.item.url || (res.item.documentId ? `/documents/${encodeURIComponent(res.item.documentId)}` : '')
                  : `${pb}/api/files/profile_imports/${encodeURIComponent(res.item.id)}/${encodeURIComponent(filename)}`
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

function onPickCv(e) {
  const file = e?.target?.files?.[0]
  if (!file) return
  cvFile.value = file
  parseResult.value = null
  parseError.value = ''
}

async function analyzeCv() {
  const file = cvFile.value
  if (!file) return
  parseError.value = ''
  parseResult.value = null
  parsing.value = true
  try {
    const text = await parseDocument(file)
    parseResult.value = {
      name: extractName(text),
      email: extractEmail(text),
      phone: extractPhone(text),
      skills: extractSkills(text),
      text: text.length > 500 ? text.slice(0, 500) + '…' : text,
      fullText: text,
    }
  } catch (e) {
    parseError.value = t('profile.parseError')
  } finally {
    parsing.value = false
  }
}

function useName() {
  if (parseResult.value?.name) {
    form.name = parseResult.value.name
    app.toast = { kind: 'ok', text: t('profile.nameApplied') }
  }
}

function useEmail() {
  if (parseResult.value?.email) {
    app.toast = { kind: 'info', text: `${t('profile.emailDetected')}: ${parseResult.value.email}` }
  }
}

function addAllSkills() {
  if (parseResult.value?.skills?.length) {
    const existing = form.skills ? form.skills.split(',').map(s => s.trim()).filter(Boolean) : []
    const merged = [...new Set([...existing, ...parseResult.value.skills])]
    form.skills = merged.join(', ')
    app.toast = { kind: 'ok', text: t('profile.skillsAdded', { n: parseResult.value.skills.length }) }
  }
}

async function save() {
  const name = String(form.name || '').trim()
  const title = String(form.title || '').trim()
  const location = String(form.location || '').trim()

  if (name.length < 2 || title.length < 2 || location.length < 2) {
    app.toast = { kind: 'info', text: t('profile.fieldsRequired') }
    return
  }

  try {
    // Desktop writes carry the last confirmed revision: sending PUT /profile while this
    // state write is still in flight made the host reject one of them as a conflict.
    await app.updateProfile(app.role, {
      name,
      title,
      location,
      skills: app.role === 'empresa' ? [] : form.skills.split(',').map((s) => s.trim()).filter(Boolean),
      about: form.about,
      public: app.role === 'empresa' ? true : !!form.public,
    })
    if (serverCompanyProfile()) {
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
    app.toast = { kind: 'info', text: `${t('profile.saveServerError')}: ${e?.message || e}` }
    return
  }

  app.toast = { kind: 'ok', text: t('profile.saved') }

  if (isOnboarding.value) {
    const next = typeof route.query.next === 'string' ? route.query.next : '/'
    await router.replace(next)
  }
}

async function copy() {
  const text = JSON.stringify(app.state.profile[app.role], null, 2)
  await navigator.clipboard.writeText(text)
  app.toast = { kind: 'ok', text: t('profile.copied') }
}
</script>
