<template>
  <div class="wrap">
    <div class="head">
      <div>
        <div class="t">{{ l.title }}</div>
        <div class="m">{{ l.company }} · {{ l.location }} · {{ l.pay }}</div>
      </div>
      <button class="btn" @click="$emit('close')">Cerrar</button>
    </div>

    <hr class="sep" />

    <div class="row" style="justify-content: space-between; align-items: flex-start">
      <div class="stack" style="gap: 6px">
        <div class="m">Tipo: <span class="muted">{{ l.kind }}</span></div>
        <div class="m">Tags: <span class="muted">{{ (l.tags || []).join(', ') || '—' }}</span></div>
      </div>

      <div class="row" style="gap: 8px">
        <button class="btn" @click="app.toggleFavorite(l.id)">
          {{ app.favorites.has(l.id) ? '★ Favorito' : '☆ Favorito' }}
        </button>
        <button v-if="app.role === 'candidato'" class="btn primary" @click="app.applyToListingServer(l.id)">
          Aplicar
        </button>
      </div>
    </div>

    <div class="card" style="margin-top: 10px">
      <div class="muted" style="font-size: 12px; margin-bottom: 6px">Descripción</div>
      <div style="white-space: pre-wrap">{{ l.desc }}</div>
    </div>

    <!-- Staff can correct or withdraw an offer; the host refuses deleting one with applications. -->
    <div v-if="app.role === 'empresa' && l.ownerUserId !== undefined" class="card stack" style="margin-top: 10px; gap: 8px">
      <div class="row" style="gap: 8px; justify-content: flex-end">
        <button v-if="!editing" class="btn" type="button" :disabled="busy" @click="startEdit">{{ t('publish.editOffer') }}</button>
        <button v-if="!editing && !confirmingDelete" class="btn" type="button" :disabled="busy" @click="confirmingDelete = true">{{ t('publish.deleteOffer') }}</button>
        <template v-if="confirmingDelete">
          <span class="m">{{ t('publish.deleteOfferConfirm') }}</span>
          <button class="btn" type="button" :disabled="busy" @click="confirmingDelete = false">{{ t('publish.cancelEdit') }}</button>
          <button class="btn primary" type="button" :disabled="busy" @click="remove">{{ t('publish.deleteOffer') }}</button>
        </template>
      </div>
      <form v-if="editing" class="stack" style="gap: 8px" @submit.prevent="save">
        <select class="input" v-model="draft.kind">
          <option value="empleo">{{ t('search.employment') }}</option>
          <option value="ett">ETT</option>
          <option value="becario">Becario</option>
        </select>
        <input class="input" v-model="draft.title" :placeholder="t('publish.titleField')" required />
        <input class="input" v-model="draft.company" :placeholder="t('publish.company')" required />
        <input class="input" v-model="draft.location" :placeholder="t('publish.location')" required />
        <input class="input" v-model="draft.pay" :placeholder="t('publish.salary')" />
        <input class="input" v-model="draft.tags" :placeholder="t('publish.tags')" />
        <textarea class="input" v-model="draft.desc" rows="5" :placeholder="t('publish.description')" />
        <div class="row" style="gap: 8px; justify-content: flex-end">
          <button class="btn" type="button" :disabled="busy" @click="editing = false">{{ t('publish.cancelEdit') }}</button>
          <button class="btn primary" type="submit" :disabled="busy">{{ t('publish.saveOffer') }}</button>
        </div>
      </form>
      <div v-if="error" class="m" role="alert" style="color: var(--danger)">{{ error }}</div>
    </div>

    <div v-if="app.role === 'empresa'" class="card" style="margin-top: 10px">
      <div class="row" style="justify-content: space-between; align-items: center">
        <div>
          <div style="font-weight: 650">Proceso de Selección</div>
          <div class="muted" style="font-size: 12px">Gestiona aplicantes y mueve etapas dentro del anuncio.</div>
        </div>
        <RouterLink class="btn" :to="`/proceso-server?listingId=${encodeURIComponent(l.id)}`">Abrir</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { t } from '../lib/i18n.js'

const props = defineProps({ id: { type: String, required: true } })
const emit = defineEmits(['close'])
const app = useAppStore()

const l = computed(() => app.listings.find((x) => x.id === props.id) || { id: props.id, title: '(no encontrado)', tags: [] })

const editing = ref(false)
const confirmingDelete = ref(false)
const busy = ref(false)
const error = ref('')
const draft = reactive({ kind: 'empleo', title: '', company: '', location: '', pay: '', tags: '', desc: '' })

function startEdit() {
  Object.assign(draft, { kind: l.value.kind || 'empleo', title: l.value.title || '', company: l.value.company || '', location: l.value.location || '', pay: l.value.pay || '', tags: (l.value.tags || []).join(', '), desc: l.value.desc || '' })
  error.value = ''
  editing.value = true
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    await app.updateListingServer(props.id, { ...draft })
    editing.value = false
    app.toast = { kind: 'ok', text: t('publish.offerUpdated') }
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function remove() {
  busy.value = true
  error.value = ''
  try {
    await app.deleteListingServer(props.id)
    app.toast = { kind: 'ok', text: t('publish.offerDeleted') }
    emit('close')
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    busy.value = false
    confirmingDelete.value = false
  }
}
</script>

<style scoped>
.wrap {
  padding: 16px;
  height: 100%;
  overflow: auto;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.t {
  font-size: 16px;
  font-weight: 650;
}

.m {
  font-size: 12px;
  color: var(--muted);
}

.cand {
  display: grid;
  grid-template-columns: 1fr 150px;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--line);
  padding: 10px;
  background: var(--card2);
}
</style>
