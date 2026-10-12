<template>
  <div class="login-page">
    <!-- Background glow -->
    <div class="login-glow" />

    <div class="login-card card card-glass">
      <!-- Brand -->
      <div class="login-brand">
        <div class="login-brand-icon">
          <LayoutGrid :size="22" />
        </div>
        <h1 class="login-title">{{ t('login.title') }}</h1>
        <p class="login-subtitle">{{ t('login.subtitle') }}</p>
      </div>

      <!-- Form -->
      <form class="login-form" @submit.prevent="onSubmit">
        <div class="field-group">
          <label class="field-label">{{ t('login.email') }}</label>
          <div class="input-wrapper">
            <Mail :size="16" class="input-icon" />
            <input
              class="input"
              v-model="email"
              type="email"
              :placeholder="t('login.emailPlaceholder')"
              autocomplete="email"
              required
              autofocus
            />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">{{ t('login.password') }}</label>
          <div class="input-wrapper">
            <Lock :size="16" class="input-icon" />
            <input
              class="input"
              v-model="password"
              type="password"
              :placeholder="t('login.passwordPlaceholder')"
              autocomplete="current-password"
              required
            />
          </div>
        </div>

        <button
          class="btn btn-primary w-full"
          type="submit"
          :disabled="auth.loading"
        >
          <Loader :size="16" v-if="auth.loading" class="spinner" />
          <LogIn :size="16" v-else />
          <span>{{ auth.loading ? t('login.loggingIn') : t('login.login') }}</span>
        </button>

        <transition name="shake">
          <div v-if="error" class="login-error">
            <AlertCircle :size="14" />
            <span>{{ error }}</span>
          </div>
        </transition>
      </form>

      <!-- Footer -->
      <div class="login-footer">
        <Shield :size="12" />
        <span>{{ t('login.secure') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { t } from '../lib/i18n.js'
import { LayoutGrid, Mail, Lock, LogIn, Loader, AlertCircle, Shield } from 'lucide-vue-next'

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
    error.value = e?.message ?? t('login.error')
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg);
  position: relative;
  overflow: hidden;
  padding: 24px;
}

.login-glow {
  position: absolute;
  top: -30%;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  height: 600px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.12), transparent 70%);
  pointer-events: none;
}

.login-card {
  width: min(420px, 100%);
  padding: 40px 36px;
  position: relative;
  z-index: 1;
  animation: fadeIn 0.5s ease, slideUp 0.5s ease;
}

.login-brand {
  text-align: center;
  margin-bottom: 32px;
}

.login-brand-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-secondary));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  margin-bottom: 16px;
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
}

.login-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 6px 0;
  color: var(--color-text);
}

.login-subtitle {
  font-size: 13px;
  color: var(--color-muted);
  margin: 0;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.input-icon {
  position: absolute;
  left: 12px;
  color: var(--color-faint);
  pointer-events: none;
}

.input-wrapper .input {
  padding-left: 40px;
}

.login-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: var(--color-danger);
  font-size: 13px;
}

.spinner {
  animation: spin 0.8s linear infinite;
}

.login-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-faint);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.shake-enter-active {
  animation: shake 0.4s ease;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px); }
  40% { transform: translateX(6px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(4px); }
}
</style>
