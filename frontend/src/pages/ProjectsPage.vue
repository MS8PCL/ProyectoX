<template>
  <div class="page">
    <div class="head">
      <h1 class="h">Proyectos</h1>
      <button class="btn" @click="add">Nuevo</button>
    </div>

    <div class="list">
      <RouterLink v-for="p in projects" :key="p.id" class="row" :to="`/projects/${p.id}`">
        <div class="title">{{ p.name }}</div>
        <div class="meta">{{ p.id }}</div>
      </RouterLink>
    </div>

    <p class="hint">
      (De momento es mock. Luego lo conectamos a PocketBase a través del backend.)
    </p>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const projects = ref([
  { id: 'alpha', name: 'Alpha' },
  { id: 'bravo', name: 'Bravo' },
])

function add() {
  const id = `p_${Math.random().toString(16).slice(2, 8)}`
  projects.value = [{ id, name: `Proyecto ${projects.value.length + 1}` }, ...projects.value]
}
</script>

<style scoped>
.page {
  display: grid;
  gap: 12px;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.h {
  margin: 0;
  font-size: 18px;
}

.btn {
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.list {
  display: grid;
  gap: 8px;
}

.row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  text-decoration: none;
  color: inherit;
}

.row:hover {
  border-color: rgba(255, 255, 255, 0.22);
}

.title {
  font-size: 14px;
}

.meta {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
    monospace;
  font-size: 12px;
  opacity: 0.65;
}

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}
</style>
