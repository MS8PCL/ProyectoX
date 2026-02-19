<template>
  <div class="wrap">
    <div class="card">
      <header class="head">
        <div class="h">Acceso</div>
        <div class="p">Email + password. Sesión por cookie (HttpOnly).</div>
      </header>

      <form class="form" @submit.prevent="onSubmit">
        <label class="field">
          <span class="k">Email</span>
          <input class="in" v-model="email" type="email" autocomplete="email" required />
        </label>
        <label class="field">
          <span class="k">Password</span>
          <input class="in" v-model="password" type="password" autocomplete="current-password" required />
        </label>

        <button class="btn" type="submit" :disabled="auth.loading">
          {{ auth.loading ? 'Entrando…' : 'Entrar' }}
        </button>

        <p v-if="error" class="err">{{ error }}</p>
      </form>

      <footer class="hint">
        <div class="muted" style="font-size: 12px">Proyecto X</div>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const error = ref(null)

async function onSubmit() {
  error.value = null
  try {
    await auth.login(email.value, password.value)
    const next = route.query.next ?? '/'
    await router.replace(next)
  } catch (e) {
    error.value = e?.message ?? 'Error'
  }
}
</script>

<style scoped>
.wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--ink);
  padding: 20px;
}

.card {
  width: min(440px, 100%);
  border: 1px solid var(--line2);
  background: var(--card);
  padding: 18px;
}

.head {
  margin-bottom: 16px;
}

.h {
  font-weight: 700;
  letter-spacing: 0.02em;
}

.p {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}

.form {
  display: grid;
  gap: 12px;
}

.field {
  display: grid;
  gap: 6px;
}

.k {
  font-size: 12px;
  color: var(--muted);
}

.in {
  padding: 10px 12px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--line);
  outline: none;
  font: inherit;
}

.in:focus {
  border-color: var(--line2);
}

.btn {
  padding: 10px 12px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--line2);
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.err {
  font-size: 12px;
  color: color-mix(in oklab, var(--danger) 70%, var(--ink));
}

.hint {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

/* removed mono hint */
</style>
