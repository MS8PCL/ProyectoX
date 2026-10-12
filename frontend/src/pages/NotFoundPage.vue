<template>
  <div class="page">
    <h1 class="h">404</h1>
    <p class="p">Esa ruta no existe.</p>
    <RouterLink class="btn" to="/">Volver al inicio</RouterLink>
  </div>
</template>

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

.btn {
  display: inline-block;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: inherit;
  text-decoration: none;
  width: fit-content;
}
</style>
