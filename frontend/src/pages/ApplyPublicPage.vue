<template>
  <div class="wrap">
    <div class="card" style="max-width: 760px; margin: 0 auto">
      <div style="font-weight: 750; font-size: 18px">Solicitud</div>
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        {{ isDesktop() ? 'Portal público no disponible en desktop' : info?.listing ? `${info.listing.title} · ${info.listing.company}` : 'Cargando…' }}
      </div>

      <div v-if="state.error" class="card" style="margin-top: 12px; border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
        <div class="mono">{{ state.error }}</div>
      </div>

      <form v-if="!isDesktop()" class="stack" style="gap: 10px; margin-top: 12px" @submit.prevent="submit">
        <label class="field">
          <span class="k">Nombre</span>
          <input class="in" v-model="form.firstName" required maxlength="80" />
        </label>

        <label class="field">
          <span class="k">Apellidos</span>
          <input class="in" v-model="form.lastName" required maxlength="120" />
        </label>

        <label class="field">
          <span class="k">Email</span>
          <input class="in" type="email" v-model="form.email" required maxlength="120" />
        </label>

        <label class="field">
          <span class="k">Fecha de nacimiento</span>
          <input class="in" type="date" v-model="form.birthDate" required />
        </label>

        <label class="field">
          <span class="k">Carta de presentación</span>
          <textarea class="textarea" rows="6" v-model="form.coverLetter" required maxlength="5000" />
        </label>

        <div class="card" style="background: var(--card2)">
          <div style="font-weight: 650">Documentos</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">CV obligatorio. Certificados opcionales. Máx 50MB por archivo. PDF/DOC/DOCX.</div>

          <div class="stack" style="gap: 10px; margin-top: 10px">
            <label class="field">
              <span class="k">CV</span>
              <input class="in" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" @change="onPickCv" required />
              <div class="muted" style="font-size: 12px; margin-top: 6px">{{ form.cv?.name || '—' }}</div>
            </label>

            <label class="field">
              <span class="k">Certificados (opcional)</span>
              <input class="in" type="file" multiple accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" @change="onPickCerts" />
              <div class="muted" style="font-size: 12px; margin-top: 6px">
                {{ (form.certificates || []).length ? form.certificates.map((f) => f.name).join(', ') : '—' }}
              </div>
            </label>
          </div>
        </div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn" type="submit" :disabled="state.loading">
            {{ state.loading ? 'Enviando…' : 'Enviar solicitud' }}
          </button>
        </div>

        <div v-if="state.ok" class="card" style="border-color: color-mix(in oklab, var(--ok) 40%, var(--line)); background: color-mix(in oklab, var(--card) 70%, var(--ok))">
          <div style="font-weight: 650">Solicitud enviada correctamente</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">Puedes cerrar esta página.</div>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { isDesktop } from '../lib/api.js'

const route = useRoute()
const token = ref('')
const info = ref(null)

const state = reactive({ loading: false, ok: false, error: '' })
const form = reactive({
  firstName: '',
  lastName: '',
  email: '',
  birthDate: '',
  coverLetter: '',
  cv: null,
  certificates: [],
})

function isAllowedMime(m) {
  return [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ].includes(String(m || ''))
}

function validateFile(f, kind) {
  if (!f) throw new Error(`Falta ${kind}.`)
  if (typeof f.size === 'number' && f.size > 50 * 1024 * 1024) throw new Error(`${kind} supera 50MB.`)
  if (!isAllowedMime(f.type)) throw new Error(`${kind}: tipo no permitido.`)
}

function onPickCv(ev) {
  const f = ev?.target?.files?.[0] || null
  form.cv = f
}

function onPickCerts(ev) {
  const list = Array.from(ev?.target?.files || [])
  form.certificates = list
}

async function loadTokenInfo() {
  state.error = ''
  if (isDesktop()) {
    state.error = 'Las solicitudes públicas no están disponibles en modo desktop local. Utiliza la importación interna de candidatos.'
    return
  }
  try {
    const res = await fetch(`/api/apply/${encodeURIComponent(token.value)}`)
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    if (!res.ok) {
      state.error = json?.message || json?.error || text || res.statusText
      return
    }
    info.value = json
  } catch (e) {
    state.error = String(e?.message || e)
  }
}

async function submit() {
  if (isDesktop()) {
    state.error = 'Las solicitudes públicas no están disponibles en modo desktop local.'
    return
  }
  state.error = ''
  state.ok = false

  try {
    validateFile(form.cv, 'CV')
    for (const f of form.certificates || []) validateFile(f, 'Certificado')

    const fd = new FormData()
    fd.set('firstName', form.firstName)
    fd.set('lastName', form.lastName)
    fd.set('email', form.email)
    fd.set('birthDate', form.birthDate)
    fd.set('coverLetter', form.coverLetter)
    fd.set('cv', form.cv)
    for (const f of form.certificates || []) fd.append('certificates', f)

    state.loading = true
    const res = await fetch(`/api/public/apply/${encodeURIComponent(token.value)}`, { method: 'POST', body: fd })
    const text = await res.text().catch(() => '')
    const json = text ? JSON.parse(text) : null

    if (!res.ok) {
      state.error = json?.message || json?.error || text || res.statusText
      return
    }

    state.ok = true
  } catch (e) {
    state.error = String(e?.message || e)
  } finally {
    state.loading = false
  }
}

onMounted(async () => {
  token.value = String(route.params?.token || '')
  await loadTokenInfo()
})
</script>

<style scoped>
.wrap {
  padding: 16px;
}
</style>
