<!-- HOTFIX: Public registration disabled. This page is kept only to avoid build errors if referenced.
     Router redirects /register to /login.
-->
<template>
  <div class="wrap">
    <div class="card">
      <header class="head">
        <div class="h">Crear cuenta</div>
        <div class="p">Email + password. OAuth (Google/LinkedIn) más adelante.</div>
      </header>

      <form class="form" @submit.prevent="onSubmit">
        <label class="field">
          <span class="k">Email</span>
          <input class="in" v-model="email" type="email" autocomplete="email" required />
        </label>
        <label class="field">
          <span class="k">Password</span>
          <input class="in" v-model="password" type="password" autocomplete="new-password" minlength="6" required />
        </label>

        <label class="field">
          <span class="k">Rol</span>
          <select class="in" v-model="role">
            <option value="worker">Candidato</option>
            <option value="company">Empresa</option>
          </select>
        </label>

        <button class="btn" type="submit" :disabled="auth.loading">
          {{ auth.loading ? 'Creando…' : 'Crear' }}
        </button>

        <p v-if="error" class="err">{{ error }}</p>

        <p class="muted" style="font-size: 12px; margin: 0">
          ¿Ya tienes cuenta?
          <RouterLink to="/login">Entrar</RouterLink>
        </p>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useAppStore } from '../stores/app.js'

const router = useRouter()
const auth = useAuthStore()
const app = useAppStore()

const email = ref('')
const password = ref('')
const role = ref('worker')
const error = ref(null)

async function onSubmit() {
  error.value = null
  try {
    await auth.register(email.value, password.value, role.value)

    // Ensure app state exists for this user
    await app.bootstrap()

    // Sync role to app store
    app.state.role = role.value === 'worker' ? 'candidato' : 'empresa'
    await app._persist()

    // Redirect to onboarding profile
    await router.replace({ name: 'perfil', query: { onboarding: '1' } })
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

a { color: inherit; }
</style>
