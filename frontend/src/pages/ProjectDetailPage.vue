<template>
  <div class="page">
    <h1 class="h">Proyecto: {{ id }}</h1>
    <p class="p">Pantalla de detalle (placeholder).</p>

    <div class="card">
      <div class="k">Acciones</div>
      <div class="actions">
        <RouterLink class="btn" to="/projects">Volver</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const id = computed(() => String(route.params.id))
</script>

<style scoped>
.page {
  display: grid;
  gap: 12px;
}

.h {
  margin: 0;
  font-size: 18px;
}

.p {
  margin: 0;
  font-size: 13px;
  opacity: 0.78;
}

.card {
  border: 1px solid rgba(255, 255, 255, 0.10);
  padding: 14px;
}

.k {
  font-size: 12px;
  opacity: 0.7;
}

.actions {
  margin-top: 10px;
}

.btn {
  display: inline-block;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: inherit;
  text-decoration: none;
}
</style>
