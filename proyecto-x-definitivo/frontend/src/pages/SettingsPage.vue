<template>
  <div class="page">
    <h1 class="h">Ajustes</h1>
    <p class="p">Aquí meteremos configuración de cuenta / preferencias más adelante.</p>

    <div class="card">
      <div class="k">API URL</div>
      <div class="mono">{{ apiUrl }}</div>
    </div>
  </div>
</template>

<script setup>
const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
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

.mono {
  margin-top: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
    monospace;
  font-size: 12px;
  opacity: 0.75;
}
</style>
