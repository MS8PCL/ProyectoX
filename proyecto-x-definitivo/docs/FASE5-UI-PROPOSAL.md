# FASE 5 — UI refinement proposal (inspiración: oat.ink)

**Objetivo:** mejorar legibilidad/jerarquía y sensación de producto interno serio (sobrio), sin convertirlo en landing SaaS flashy.

## Observaciones de oat.ink (alto nivel)
Lo más reutilizable no es el “look” exacto, sino estos patrones:
- Tipografía grande + jerarquía clara (títulos/labels/subtexto).
- Cards con bordes finos + padding consistente.
- Espaciado vertical generoso (stack/gap) para respirar.
- Componentes interactivos con estados (hover/focus/active) muy definidos.
- Modales con estructura clara: header, body, footer; acciones agrupadas.
- Transiciones suaves y cortas (100–180ms) para cambios de estado.

## Componentes aplicables (sin copiar literal)
### 1) Tarjetas de candidatura (PipelineServerPage)
**Aplicar:**
- Separar visualmente: nombre (strong) / email (muted) / acciones.
- Hacer el botón `×` menos “agresivo” pero igual de visible (hover rojo, focus visible).
- Mejorar densidad: alinear acciones en una esquina, evitar saltos de layout.

**Impacto técnico:** bajo (CSS + pequeña estructura HTML).

### 2) Columnas del pipeline
**Aplicar:**
- Header fijo por columna con contador.
- Estado vacío más claro (texto + icono minimal) para que no parezca bug.
- Drop targets: highlight más suave y consistente (no parpadeo).

**Impacto técnico:** bajo/medio (CSS + un par de estados reactivos).

### 3) Modales (candidate/import/apply link)
**Aplicar:**
- Footer fijo con acciones (Cancelar / Confirmar) + descripciones cortas.
- Inputs con labels consistentes + ayudas en muted.
- Tabs con indicador activo más marcado (borde inferior o background sutil).

**Impacto técnico:** medio (refactor de markup, mantener compatibilidad).

### 4) Micro-interacciones
**Aplicar:**
- `transition` en hover/focus (color/border/background) 120–160ms.
- Animación sutil al abrir modal (opacity + translateY pequeño).

**Impacto técnico:** bajo (CSS).

## Dónde aplicarlo
- `frontend/src/pages/PipelineServerPage.vue` (pipeline cards, columnas, modales)
- `frontend/src/components/ModalShell.vue` (si existe; si no, el wrapper actual)
- `frontend/src/assets/*` / variables CSS globales (tokens de spacing, border, radii)

## Qué NO tocar
- Flujos críticos (Alta IT / Enterprise / RBAC).
- Routing/back-compat ya fijado (`/interno/seleccion → /candidatos`).
- Lógica de datos (PocketBase polling, endpoints).

## Riesgos
- Cambios de markup en modales pueden romper selectors/tests manuales.
- Ajustes de layout podrían afectar drag&drop si cambian los contenedores de drop.

## Plan recomendado
1) Introducir **tokens CSS** (spacing/border/hover) y aplicarlos a cards/modales.
2) Refactor leve de estructura de modal: header/body/footer.
3) Pulir pipeline cards (alineación acciones, hover, focus visible).

