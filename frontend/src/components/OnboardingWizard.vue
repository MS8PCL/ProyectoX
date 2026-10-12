<template>
  <Teleport to="body">
    <div v-if="visible" class="onboarding-overlay">
      <div class="onboarding-blur" @click="dismiss" />
      <div class="onboarding-modal">
        <!-- Progress bar -->
        <div class="onboarding-progress">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progressPct + '%' }" />
          </div>
          <div class="progress-dots">
            <button
              v-for="(step, i) in steps"
              :key="i"
              class="progress-dot"
              :class="{ active: i <= current, done: i < current }"
              @click="goTo(i)"
            >
              <Check v-if="i < current" :size="14" />
              <span v-else>{{ i + 1 }}</span>
            </button>
          </div>
        </div>

        <!-- Step content -->
        <div class="onboarding-body">
          <Transition :name="slideDir" mode="out-in">
            <div :key="current" class="step-content">
              <!-- Step 1 -->
              <div v-if="current === 0" class="step">
                <div class="step-icon accent">
                  <PartyPopper :size="40" />
                </div>
                <h2 class="step-title">{{ t('onboarding.welcome') }}</h2>
                <p class="step-desc">
                  {{ t('onboarding.welcomeDesc') }}
                </p>
                <div class="step-features">
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureP1') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureP2') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureP3') }}</span>
                  </div>
                </div>
              </div>

              <!-- Step 2 -->
              <div v-if="current === 1" class="step">
                <div class="step-icon accent2">
                  <GanttChart :size="40" />
                </div>
                <h2 class="step-title">{{ t('onboarding.step1') }}</h2>
                <p class="step-desc">
                  {{ t('onboarding.step1Desc') }}
                </p>
                <div class="step-features">
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureS1') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureS2') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureS3') }}</span>
                  </div>
                </div>
              </div>

              <!-- Step 3 -->
              <div v-if="current === 2" class="step">
                <div class="step-icon accent3">
                  <Building2 :size="40" />
                </div>
                <h2 class="step-title">{{ t('onboarding.step2') }}</h2>
                <p class="step-desc">
                  {{ t('onboarding.step2Desc') }}
                </p>
                <div class="step-features">
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureE1') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureE2') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featureE3') }}</span>
                  </div>
                </div>
              </div>

              <!-- Step 4 -->
              <div v-if="current === 3" class="step">
                <div class="step-icon accent4">
                  <UserCheck :size="40" />
                </div>
                <h2 class="step-title">{{ t('onboarding.step3') }}</h2>
                <p class="step-desc">
                  {{ t('onboarding.step3Desc') }}
                </p>
                <div class="step-features">
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featurePR1') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featurePR2') }}</span>
                  </div>
                  <div class="feature-item">
                    <span class="feature-dot" />
                    <span>{{ t('onboarding.featurePR3') }}</span>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>

        <!-- Footer -->
        <div class="onboarding-footer">
          <button
            v-if="current > 0"
            class="btn btn-ghost btn-sm"
            @click="prev"
          >
            <ArrowLeft :size="16" />
            {{ t('onboarding.prev') }}
          </button>
          <div v-else />

          <button
            v-if="current < steps.length - 1"
            class="btn btn-primary btn-sm"
            @click="next"
          >
            {{ t('onboarding.nextBtn') }}
            <ArrowRight :size="16" />
          </button>
          <button
            v-else
            class="btn btn-primary btn-sm"
            @click="finish"
          >
            {{ t('onboarding.startBtn') }}
            <Check :size="16" />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue'
import { t } from '../lib/i18n.js'
import { PartyPopper, GanttChart, Building2, UserCheck, ArrowRight, ArrowLeft, Check } from 'lucide-vue-next'

const emit = defineEmits(['done'])
const visible = ref(true)
const current = ref(0)
const slideDir = ref('slide-left')
const STORAGE_KEY = 'px_onboarding'

const steps = [
  { label: 'Bienvenido' },
  { label: 'Pipeline' },
  { label: 'Enterprise' },
  { label: 'Perfil' },
]

const progressPct = computed(() => ((current.value + 1) / steps.length) * 100)

function next() {
  if (current.value < steps.length - 1) {
    slideDir.value = 'slide-left'
    current.value++
  }
}

function prev() {
  if (current.value > 0) {
    slideDir.value = 'slide-right'
    current.value--
  }
}

function goTo(i) {
  slideDir.value = i > current.value ? 'slide-left' : 'slide-right'
  current.value = i
}

function finish() {
  localStorage.setItem(STORAGE_KEY, 'v2')
  visible.value = false
  emit('done')
}

function dismiss() {
  // Don't dismiss by clicking backdrop — user must go through wizard
}
</script>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.onboarding-blur {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.onboarding-modal {
  position: relative;
  width: min(540px, 96vw);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  max-height: min(90vh, 640px);
}

/* Progress */
.onboarding-progress {
  padding: 24px 24px 0;
}

.progress-bar {
  height: 4px;
  background: var(--color-surface-hover);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 16px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-accent), var(--color-accent-secondary));
  border-radius: 2px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.progress-dots {
  display: flex;
  justify-content: center;
  gap: 32px;
}

.progress-dot {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
}

.progress-dot.active {
  border-color: var(--color-accent);
  color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
}

.progress-dot.done {
  border-color: var(--color-success);
  background: var(--color-success);
  color: #fff;
}

/* Body */
.onboarding-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  padding: 24px;
}

.step-content {
  width: 100%;
}

.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 16px;
}

.step-icon {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
}

.step-icon.accent {
  background: linear-gradient(135deg, var(--color-accent), color-mix(in srgb, var(--color-accent) 60%, var(--color-accent-secondary)));
  color: #fff;
}

.step-icon.accent2 {
  background: linear-gradient(135deg, var(--color-accent-secondary), color-mix(in srgb, var(--color-accent-secondary) 60%, var(--color-accent)));
  color: #fff;
}

.step-icon.accent3 {
  background: linear-gradient(135deg, var(--color-info), var(--color-accent-secondary));
  color: #fff;
}

.step-icon.accent4 {
  background: linear-gradient(135deg, var(--color-success), var(--color-accent));
  color: #fff;
}

.step-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--color-text);
}

.step-desc {
  font-size: 14px;
  color: var(--color-muted);
  line-height: 1.7;
  margin: 0;
  max-width: 400px;
}

.step-features {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
  text-align: left;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--color-muted);
}

.feature-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}

/* Footer */
.onboarding-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  border-top: 1px solid var(--color-border);
}

/* Slide transitions */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.slide-left-enter-from {
  opacity: 0;
  transform: translateX(40px);
}

.slide-left-leave-to {
  opacity: 0;
  transform: translateX(-40px);
}

.slide-right-enter-from {
  opacity: 0;
  transform: translateX(-40px);
}

.slide-right-leave-to {
  opacity: 0;
  transform: translateX(40px);
}

@media (max-width: 600px) {
  .onboarding-modal {
    width: 100vw;
    max-height: 100vh;
    border-radius: 0;
    height: 100vh;
  }

  .onboarding-overlay {
    padding: 0;
  }

  .progress-dots {
    gap: 20px;
  }
}
</style>
