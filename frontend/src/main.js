import { createApp } from "vue";
import { createPinia } from "pinia";
import { router } from "./router";
import { useAuthStore } from "./stores/auth.js";
import { useAppStore } from "./stores/app.js";
import { api, isDesktop, getDesktopState } from "./lib/api.js";
import App from "./App.vue";

import "./style.css";
import "./tailwind.css";

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

function showDesktopConnectionError(error) {
  if (document.getElementById("desktop-connection-error")) return;
  const overlay = document.createElement("div");
  overlay.id = "desktop-connection-error";
  overlay.setAttribute("role", "alert");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:var(--bg, #111827);padding:24px";
  const card = document.createElement("section");
  card.className = "card card-glass";
  card.style.cssText = "max-width:560px;padding:24px";
  const title = document.createElement("h2");
  title.textContent = "No se pudo conectar con Proyecto X Desktop";
  const detail = document.createElement("p");
  detail.textContent = error?.message || "El host desktop no está disponible.";
  const advice = document.createElement("p");
  advice.textContent = "Compruebe el host y el almacenamiento compartido. No se ha iniciado una sesión web ni se reintentará ninguna escritura automáticamente.";
  card.append(title, detail, advice);
  overlay.append(card);
  document.body.append(overlay);
}

// Auth guard must run after Pinia is installed (avoid "no active Pinia").
router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia);
  const appStore = useAppStore(pinia);

  try {
    await auth.bootstrap();
  } catch (error) {
    if (!isDesktop()) throw error;
    showDesktopConnectionError(error);
    return false;
  }

  // Public routes: login/register
  if (to.meta.public) {
    if (auth.isAuthed) return { name: "home" };
    return true;
  }

  // Everything else requires an authenticated session
  if (to.meta.requiresAuth && !auth.isAuthed) {
    return { name: "login", query: { next: to.fullPath } };
  }

  // Ensure app state is ready
  try {
    await appStore.bootstrap();
  } catch (error) {
    if (!isDesktop()) throw error;
    showDesktopConnectionError(error);
    return false;
  }

  // Sync role from authenticated user.
  // Internal-only mode: admin/rrhh/it behave as "empresa" in the UI (RRHH tool).
  const internal = ["admin", "rrhh", "it"].includes(
    String(auth.user?.role || ""),
  );
  const serverRole = internal
    ? "empresa"
    : auth.user?.role === "company"
      ? "empresa"
      : "candidato";
  if (appStore.state?.role && appStore.state.role !== serverRole) {
    appStore.state.role = serverRole;
    // Presentation only, never an ACL. Desktop app-store persistence belongs to its transport.
    if (!isDesktop()) await appStore._persist();
  }

  // Server-side onboarding gate (PocketBase source of truth)
  // Internal roles do NOT require onboarding profiles.
  if (!internal && !isDesktop()) {
    try {
      const status = await api("/onboarding/status");
      if (!status?.complete && to.name !== "perfil") {
        return {
          name: "perfil",
          query: { onboarding: "1", next: to.fullPath },
        };
      }
    } catch {
      // If backend is down, fallback to local heuristic.
      if (to.name !== "perfil" && !appStore.isProfileComplete(appStore.role)) {
        return {
          name: "perfil",
          query: { onboarding: "1", next: to.fullPath },
        };
      }
    }
  }

  return true;
});

async function start() {
  if (isDesktop()) {
    try {
      await useAuthStore(pinia).bootstrap();
      // Preflight catches connection failures even if the legacy app store swallows them.
      const result = await api("/state");
      if (!result || !Object.hasOwn(result, "state") ||
          (result.state !== null && (typeof result.state !== "object" || Array.isArray(result.state))) ||
          getDesktopState().revision === null) {
        throw new Error("El host desktop no ha proporcionado un estado legacy y una revisión válidos.");
      }
    } catch (error) {
      showDesktopConnectionError(error);
      return;
    }
  }
  app.use(router);
  app.mount("#app");
}

void start();
