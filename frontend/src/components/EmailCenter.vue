<template>
  <ModalShell @close="$emit('close')">
    <template #title>Centro de Emails</template>
    <div class="stack">
      <!-- Template selector -->
      <div class="card">
        <div class="font-bold mb-8">Seleccioná un template</div>
        <div class="row gap-8 flex-wrap">
          <button
            v-for="t in templates"
            :key="t.id"
            class="btn btn-sm"
            :class="selectedId === t.id ? 'btn-secondary' : 'btn-ghost'"
            type="button"
            @click="selectTemplate(t)"
          >
            {{ t.label }}
          </button>
        </div>
      </div>

      <!-- Preview -->
      <div v-if="selected" class="card stack gap-8">
        <div class="font-bold">Vista previa</div>

        <div class="stack gap-8">
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Asunto</label>
            <input class="input" :value="resolvedSubject" readonly />
          </div>
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Cuerpo</label>
            <div class="card" style="background: var(--color-bg); white-space: pre-wrap; max-height: 200px; overflow-y: auto">
              {{ resolvedBody }}
            </div>
          </div>
        </div>

        <div class="row gap-8 flex-wrap">
          <button class="btn btn-primary btn-sm" type="button" @click="simulateSend">
            <Send :size="14" />
            Enviar
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="$emit('close')">
            Omitir
          </button>
        </div>

        <div v-if="sentConfirm" class="card" style="border-color: color-mix(in oklab, var(--color-success) 50%, var(--color-border)); background: var(--color-success-soft)">
          <div class="text-sm" style="color: var(--color-success)">✓ Email enviado (simulación) — {{ sentConfirm }}</div>
        </div>
      </div>

      <!-- History (collapsible) -->
      <div class="card">
        <button
          class="row justify-between items-center w-full"
          type="button"
          style="background: transparent; border: none; color: inherit; cursor: pointer; padding: 0"
          @click="showHistory = !showHistory"
        >
          <div class="font-bold">Historial ({{ history.length }})</div>
          <component :is="showHistory ? ChevronUp : ChevronDown" :size="16" />
        </button>

        <div v-if="showHistory" class="stack gap-8 mt-8">
          <div v-if="!history.length" class="muted text-sm">Sin emails enviados.</div>
          <div v-for="(h, i) in history" :key="i" class="card" style="background: var(--color-bg); padding: 12px">
            <div class="row justify-between items-center">
              <div>
                <div class="font-semibold text-sm">{{ h.template }}</div>
                <div class="muted text-sm mt-4">{{ h.to }} · {{ h.subject }}</div>
              </div>
              <div class="muted text-sm">{{ fmtTime(h.ts) }}</div>
            </div>
            <div class="muted text-sm mt-4" style="white-space: pre-wrap; max-height: 60px; overflow: hidden; text-overflow: ellipsis">{{ h.body.slice(0, 120) }}{{ h.body.length > 120 ? '…' : '' }}</div>
          </div>
          <button v-if="history.length" class="btn btn-ghost btn-sm" type="button" @click="clearHistory">Limpiar historial</button>
        </div>
      </div>
    </div>
  </ModalShell>
</template>

<script setup>
import { computed, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { Send, ChevronUp, ChevronDown } from 'lucide-vue-next'
import { loadState, saveState } from '../lib/storage.js'

const props = defineProps({
  candidateName: { type: String, default: '' },
  candidateEmail: { type: String, default: '' },
  puesto: { type: String, default: '' },
  empresa: { type: String, default: '' },
})

const emit = defineEmits(['close'])

const templates = [
  {
    id: 'entrevista',
    label: 'Invitación a entrevista',
    subject: 'Invitación a entrevista — {{puesto}}',
    body: `Hola {{nombre}},

Nos complace invitarte a una entrevista para el puesto de {{puesto}} en {{empresa}}.

Pronto nos pondremos en contacto para coordinar fecha y hora.

¡Saludos!
Equipo de {{empresa}}`,
  },
  {
    id: 'oferta',
    label: 'Oferta de trabajo',
    subject: 'Oferta de trabajo — {{puesto}}',
    body: `Hola {{nombre}},

Nos complace informarte que has sido seleccionado/a para el puesto de {{puesto}} en {{empresa}}.

En breve recibirás los detalles de la oferta y los próximos pasos.

¡Felicitaciones!
Equipo de {{empresa}}`,
  },
  {
    id: 'rechazo',
    label: 'Rechazo',
    subject: 'Actualización sobre tu candidatura — {{puesto}}',
    body: `Hola {{nombre}},

Gracias por tu interés en el puesto de {{puesto}} en {{empresa}}.

Lamentablemente, en esta ocasión hemos decidido continuar con otros candidatos. Valoramos tu tiempo y te deseamos mucho éxito.

¡Saludos!
Equipo de {{empresa}}`,
  },
  {
    id: 'seguimiento',
    label: 'Seguimiento',
    subject: 'Seguimiento de tu candidatura — {{puesto}}',
    body: `Hola {{nombre}},

Queríamos ponernos en contacto para darte una actualización sobre tu candidatura para {{puesto}} en {{empresa}}.

Tu perfil sigue siendo de nuestro interés y estamos evaluando los próximos pasos. Te mantendremos informado/a.

¡Saludos!
Equipo de {{empresa}}`,
  },
]

const selectedId = ref('')
const selected = computed(() => templates.find((t) => t.id === selectedId.value) || null)

const sentConfirm = ref('')

const showHistory = ref(false)

const LS_EMAIL_KEY = 'proyecto_x_email_history'

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(LS_EMAIL_KEY) || '[]')
  } catch {
    return []
  }
}

const history = ref(loadHistory())

function saveHistory() {
  localStorage.setItem(LS_EMAIL_KEY, JSON.stringify(history.value))
}

function resolve(str) {
  return String(str || '')
    .replace(/\{\{nombre\}\}/g, props.candidateName || 'Candidato/a')
    .replace(/\{\{puesto\}\}/g, props.puesto || '(puesto)')
    .replace(/\{\{empresa\}\}/g, props.empresa || 'Proyecto X')
}

const resolvedSubject = computed(() => resolve(selected.value?.subject || ''))
const resolvedBody = computed(() => resolve(selected.value?.body || ''))

function selectTemplate(t) {
  selectedId.value = t.id
  sentConfirm.value = ''
}

function simulateSend() {
  if (!selected.value || !props.candidateEmail) return
  sentConfirm.value = `a ${props.candidateEmail}`
  history.value.unshift({
    template: selected.value.label,
    to: props.candidateEmail,
    subject: resolvedSubject.value,
    body: resolvedBody.value,
    ts: Date.now(),
  })
  // Keep last 50
  if (history.value.length > 50) history.value = history.value.slice(0, 50)
  saveHistory()
}

function clearHistory() {
  history.value = []
  saveHistory()
}

function fmtTime(ts) {
  const d = new Date(ts)
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>
