<template>
  <div class="combo" @keydown.esc.prevent="close">
    <label v-if="label" class="lbl">{{ label }}</label>
    <div class="row">
      <input
        class="input"
        :placeholder="placeholder"
        :value="query"
        @input="onInput"
        @focus="open"
        autocomplete="off"
      />
      <button class="btn" type="button" @click="toggle" aria-label="Toggle">▾</button>
    </div>

    <div v-if="openState" class="panel">
      <button
        v-for="opt in options"
        :key="opt.id"
        class="opt"
        type="button"
        @click="select(opt)"
      >
        <span class="code">{{ opt.code }}</span>
        <span>—</span>
        <span class="name">{{ opt.name }}</span>
      </button>
      <div v-if="!options.length" class="empty">(sin resultados)</div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  label: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  modelValue: { type: Object, default: null },
  options: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:modelValue', 'search'])

const openState = ref(false)
const query = ref('')

watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    query.value = `${v.code} — ${v.name}`
  },
  { immediate: true }
)

let t
function onInput(e) {
  query.value = e.target.value
  clearTimeout(t)
  t = setTimeout(() => emit('search', query.value), 150)
  openState.value = true
}

function select(opt) {
  emit('update:modelValue', opt)
  query.value = `${opt.code} — ${opt.name}`
  openState.value = false
}

function open() {
  openState.value = true
  emit('search', query.value)
}

function close() {
  openState.value = false
}

function toggle() {
  openState.value = !openState.value
  if (openState.value) emit('search', query.value)
}
</script>

<style scoped>
.combo { position: relative; display: grid; gap: 6px; }
.lbl { font-size: 12px; color: var(--muted); }
.row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.input { width: 100%; border: 1px solid var(--line); background: var(--card); color: inherit; padding: 8px 10px; }
.btn { border: 1px solid var(--line2); background: transparent; color: inherit; padding: 8px 10px; cursor: pointer; }
.panel { position: absolute; top: calc(100% + 6px); left: 0; right: 0; border: 1px solid var(--line); background: var(--bg); z-index: 60; max-height: 260px; overflow: auto; }
.opt { width: 100%; text-align: left; border: 0; background: transparent; color: inherit; padding: 10px; display: flex; gap: 8px; cursor: pointer; }
.opt:hover { background: var(--card2); }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); min-width: 64px; }
.name { flex: 1; }
.empty { padding: 10px; color: var(--muted); font-size: 12px; }
</style>
