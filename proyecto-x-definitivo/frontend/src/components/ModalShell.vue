<template>
  <div class="backdrop" role="dialog" aria-modal="true" @click.self="$emit('close')">
    <div class="modal">
      <header class="head">
        <div class="title"><slot name="title" /></div>
        <button class="btn" type="button" @click="$emit('close')">Cerrar</button>
      </header>
      <div class="body"><slot /></div>
    </div>
  </div>
</template>

<script setup>
defineEmits(['close'])
</script>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 50;
}

.modal {
  width: min(860px, 96vw);
  max-height: min(88vh, 900px);
  overflow: auto;
  border: 1px solid var(--line);
  background: var(--bg);
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.title {
  font-weight: 650;
}

.body {
  padding: 12px;
}

.btn {
  padding: 8px 10px;
  border: 1px solid var(--line2);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
