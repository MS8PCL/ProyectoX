<template>
  <div class="stack">
    <div class="card">
      <div style="font-weight: 650">Publicar</div>
      <div class="muted" style="font-size: 12px; margin-top: 6px">Crea empleo o freelance.</div>
    </div>

    <form class="card stack" @submit.prevent="onSubmit">
      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Tipo</label>
        <select class="select" v-model="form.kind">
          <option value="empleo">empleo</option>
          <option value="freelance">freelance</option>
        </select>
      </div>

      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Título</label>
        <input class="input" v-model="form.title" required />
      </div>

      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Empresa</label>
        <input class="input" v-model="form.company" />
      </div>

      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Lugar</label>
        <input class="input" v-model="form.location" />
      </div>

      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Pago</label>
        <input class="input" v-model="form.pay" placeholder="p.ej. 45–60k / 2–4k" />
      </div>

      <div class="row" style="gap: 8px">
        <label class="muted" style="width: 90px">Tags</label>
        <input class="input" v-model="form.tags" placeholder="vue, js, remoto" />
      </div>

      <div class="row" style="gap: 8px; align-items: flex-start">
        <label class="muted" style="width: 90px; padding-top: 10px">Desc</label>
        <textarea class="textarea" rows="7" v-model="form.desc" />
      </div>

      <div class="row" style="justify-content: space-between">
        <div class="muted" style="font-size: 12px">Tip: luego lo verás en Buscar.</div>
        <button class="btn primary" type="submit">Publicar</button>
      </div>
    </form>
  </div>
</template>

<script setup>
import { reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'

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

async function onSubmit() {
  let l
  try {
    l = await app.createListingServer(form)
  } catch {
    app.toast = { kind: 'info', text: 'No se pudo publicar en el servidor. Revisa sesión y Perfil.' }
    return
  }

  // refresh feed so Buscar sea 100% server
  await app.refreshListingsFromServer().catch(() => {})

  router.push('/buscar')
  app.openDrawer(l.id)
}
</script>
