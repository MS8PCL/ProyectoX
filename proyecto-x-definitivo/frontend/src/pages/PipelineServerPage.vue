<template>
  <div class="stack">
    <div class="card">
      <div style="font-weight: 650">Proceso de Selección (server)</div>
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        Vista multi-sesión: ofertas + candidaturas en PocketBase.
      </div>
    </div>

    <div v-if="!['admin','rrhh','it'].includes(auth.user?.role)" class="card muted">Esta vista es interna (RRHH/IT/Admin).</div>

    <div v-else class="stack">
      <div v-if="!companyListings.length" class="card muted">(vacío) — crea un anuncio en Publicar.</div>

      <div v-for="l in companyListings" :key="l.id" class="card">
        <button class="accHead" type="button" @click="toggleOpen(l.id)">
          <div>
            <div style="font-weight: 650">{{ l.title }}</div>
            <div class="muted" style="font-size: 12px; margin-top: 6px">{{ l.company }} · {{ l.location }} · {{ l.pay }}</div>
          </div>
          <div class="row" style="gap: 10px; justify-content: flex-end; align-items: center">
            <span class="kbd">{{ (appsByListing[l.id]?.length || 0) }} candidatos</span>
            <span class="kbd">{{ openListingId === l.id ? '—' : '+' }}</span>
          </div>
        </button>

        <div v-if="openListingId === l.id" class="accBody">
          <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 10px">
            <div style="flex: 1"></div>
            <button class="btn" type="button" @click="openImportModal(l.id)">Importar candidatos (máx 10)</button>
            <button class="btn" type="button" @click="exportListingZip(l.id)">Exportar listing (ZIP)</button>
          </div>

          <div class="cols" style="margin-top: 10px">
            <div
              v-for="s in stages"
              :key="s"
              class="col"
              :data-dnd="drag.appId && drag.listingId === l.id"
              :data-over="over.listingId === l.id && over.stage === s"
              @dragenter.prevent="onDragEnter(l.id, s)"
              @dragover.prevent
              @dragleave="onDragLeave(l.id, s)"
              @drop.prevent="onDrop(l.id, s)"
            >
              <div class="colHead">{{ stageLabel[s] }}</div>
              <div class="stack" style="gap: 8px">
                <div
                  v-for="a in appsByStage(l.id)[s]"
                  :key="a.id"
                  class="cand"
                  draggable="true"
                  :data-dragging="drag.appId === a.id"
                  @dragstart="onDragStart(l.id, a.id, s, $event)"
                  @dragend="onDragEnd"
                  @click="selectApplication(l.id, a); toggleCandidateModal(l.id, a)"
                >
                  <button class="expbtn" type="button" :title="candidateModal.open && candidateModal.applicationId===a.id ? 'Cerrar' : 'Abrir'" @click.stop="toggleCandidateModal(l.id, a)">{{ candidateModal.open && candidateModal.applicationId===a.id ? '−' : '+' }}</button>
                  <button class="delbtn" type="button" title="Eliminar (irreversible)" @click.stop="openDeleteConfirm(l.id, a)">🗑</button>

                  <div class="row" style="justify-content: space-between; align-items: center">
                    <div>
                      <div style="font-weight: 650">{{ candName(a) }}</div>
                      <div class="muted" style="font-size: 12px; margin-top: 4px">{{ candMeta(a) }}</div>
                    </div>
                  </div>

                  <div class="notes">
                    <button v-if="!(notesUi.open && notesUi.appId === a.id)" class="notesPreview" type="button" @click.stop="openNotes(a.id)">
                      <span class="muted">Notas:</span>
                      <span class="muted">{{ notesPreview(a.notes) }}</span>
                    </button>
                    <textarea
                      v-else
                      class="textarea"
                      :value="a.notes || ''"
                      placeholder="Notas..."
                      @click.stop
                      @input="(e) => setNotes(a.id, e.target.value)"
                      @blur="closeNotes"
                    />
                  </div>
                </div>

                <div v-if="!appsByStage(l.id)[s].length" class="muted" style="font-size: 12px">
                  <span v-if="drag.appId && drag.listingId === l.id">Suelta aquí</span>
                  <span v-else>(vacío)</span>
                </div>
              </div>
            </div>
          </div>

          <div class="muted" style="font-size: 12px; margin-top: 10px">* Datos vienen de PocketBase (multi-sesión).</div>
        </div>
      </div>
    </div>

    <!-- Hard delete confirm modal -->
    <ModalShell v-if="deleteConfirm.open" @close="closeDeleteConfirm">
      <template #title>Eliminar candidatura (irreversible)</template>

      <div class="stack" style="gap: 10px">
        <div class="card">
          <div style="font-weight: 650">Confirmación</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            Esto eliminará la candidatura y sus datos asociados (tokens y profile_imports). No se puede deshacer.
          </div>
        </div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn" type="button" @click="closeDeleteConfirm" :disabled="deleteConfirm.loading">Cancelar</button>
          <button class="btn danger" type="button" @click="confirmHardDelete" :disabled="deleteConfirm.loading">
            {{ deleteConfirm.loading ? 'Eliminando…' : 'Eliminar' }}
          </button>
        </div>

        <div v-if="deleteConfirm.error" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
          <div class="mono">{{ deleteConfirm.error }}</div>
        </div>
      </div>
    </ModalShell>

    <!-- Candidate modal with tabs -->
    <ModalShell v-if="candidateModal.open" @close="closeCandidateModal">
      <template #title>
        Candidatura — {{ fullName(candidateModal.profile) || candidateModal.profile?.email || candidateModal.candidateUserId || '—' }}
      </template>

      <div class="cm-layout">
        <!-- Sidebar -->
        <aside class="cm-aside">
          <div class="cm-profile-head">
            <div class="cm-avatar">{{ (fullName(candidateModal.profile) || '?').charAt(0).toUpperCase() }}</div>
            <div>
              <div class="cm-name">{{ fullName(candidateModal.profile) || '(sin nombre)' }}</div>
              <div class="cm-stage-badge">{{ stageLabel[candidateModal.application?.stage] || '—' }}</div>
            </div>
          </div>

          <hr class="cm-sep" />

          <div class="cm-section">
            <div class="cm-section-title">Información</div>
            <div class="cm-info-row">
              <span class="cm-info-label">Email</span>
              <span class="cm-info-val">{{ candidateModal.profile?.email || '—' }}</span>
            </div>
            <div class="cm-info-row">
              <span class="cm-info-label">Fecha nac.</span>
              <span class="cm-info-val">{{ fmtDate(candidateModal.application?.birthDate) || '—' }}</span>
            </div>
          </div>

          <hr class="cm-sep" />

          <div class="cm-section">
            <div class="cm-section-title">Currículum</div>
            <div v-if="candidateModal.loadingDocs" class="cm-muted">Cargando…</div>
            <div v-else-if="!cvDocs.length" class="cm-muted">(sin CV)</div>
            <div v-else class="cm-stack">
              <div v-for="d in cvDocs" :key="d.id" class="cm-doc-row">
                <div class="cm-doc-name">{{ d.file }}</div>
                <div class="cm-row" style="gap: 4px; margin-top: 6px">
                  <button class="cm-btn-sm" type="button" @click="candidateModal.selectedDocId=d.id; candidateModal.tab='cv'">Preview</button>
                  <button class="cm-btn-sm" type="button" @click="openDoc(d)">Abrir</button>
                </div>
              </div>
            </div>
          </div>

          <hr class="cm-sep" />

          <div class="cm-section">
            <div class="cm-section-title">Link de aplicación</div>
            <div class="cm-muted" style="margin-bottom: 6px">
              <span v-if="candidateModal.loadingTokens">cargando…</span>
              <span v-else-if="latestApplyToken">{{ tokenStatus(latestApplyToken) }} · exp: {{ fmtDate(latestApplyToken.expiresAt) || '—' }}</span>
              <span v-else>sin link generado</span>
            </div>
            <div class="cm-row" style="gap: 6px">
              <button class="cm-btn-sm" type="button" :disabled="!candidateModal.applicationId" @click="openApplyLinkModal(candidateModal.listingId, candidateModal.applicationId)">Generar 🔗</button>
              <button v-if="applyLinkModal.url" class="cm-btn-sm" type="button" @click="copyApplyUrl">Copiar</button>
            </div>
          </div>
        </aside>

        <!-- Main -->
        <div class="cm-main">
          <div class="cm-tabs">
            <button class="cm-tab" :class="{ 'cm-tab-active': candidateModal.tab==='datos' }" type="button" @click="candidateModal.tab='datos'">Proceso</button>
            <button class="cm-tab" :class="{ 'cm-tab-active': candidateModal.tab==='cv' }" type="button" @click="candidateModal.tab='cv'">CV</button>
            <button class="cm-tab" :class="{ 'cm-tab-active': candidateModal.tab==='certs' }" type="button" @click="candidateModal.tab='certs'">Certificados</button>
          </div>

          <!-- Tab: Proceso -->
          <div v-if="candidateModal.tab==='datos'" class="cm-tab-body">
            <div class="cm-timeline">
              <div
                v-for="(s, idx) in stages"
                :key="s"
                class="cm-tl-item"
                :class="{
                  'cm-tl-done': stageOrder(candidateModal.application?.stage) > idx,
                  'cm-tl-current': candidateModal.application?.stage === s,
                  'cm-tl-pending': stageOrder(candidateModal.application?.stage) < idx
                }"
              >
                <div class="cm-tl-dot"></div>
                <div class="cm-tl-content">
                  <div class="cm-tl-label">{{ stageLabel[s] }}</div>
                  <div v-if="candidateModal.application?.stage === s && candidateModal.application?.notes" class="cm-tl-note">
                    {{ candidateModal.application.notes }}
                  </div>
                </div>
              </div>
            </div>

            <div class="cm-section" style="margin-top: 16px">
              <div class="cm-section-title">Cover letter</div>
              <div class="cm-cover">{{ candidateModal.application?.coverLetter || '—' }}</div>
            </div>

            <div v-if="candidateModal.outboxId" class="cm-outbox">
              <div class="cm-section-title">Alta IT generada</div>
              <div class="cm-muted mono" style="font-size: 11px; margin-top: 4px">outbox={{ candidateModal.outboxId }}</div>
              <div class="cm-muted" style="margin-top: 4px">Ve a /interno/altas para verlo.</div>
            </div>

            <div v-if="candidateModal.error" class="cm-error">{{ candidateModal.error }}</div>
          </div>

          <!-- Tab: CV -->
          <div v-else-if="candidateModal.tab==='cv'" class="cm-tab-body">
            <div v-if="candidateModal.loadingDocs" class="cm-muted">Cargando…</div>
            <div v-else-if="!cvDocs.length" class="cm-muted">(sin CV)</div>
            <div v-else class="cm-stack">
              <div v-for="d in cvDocs" :key="d.id" class="cm-doc-row">
                <div class="cm-row" style="justify-content: space-between; align-items: center">
                  <button class="cm-link" type="button" @click="candidateModal.selectedDocId=d.id">{{ d.file }}</button>
                  <div class="cm-row" style="gap: 6px">
                    <button class="cm-btn-sm" type="button" @click="candidateModal.selectedDocId=d.id">Preview</button>
                    <button class="cm-btn-sm" type="button" @click="openDoc(d)">Abrir</button>
                  </div>
                </div>
              </div>
              <div v-if="selectedDoc && selectedDoc.docType==='cv'" class="cm-preview-wrap">
                <div class="cm-muted" style="font-size: 11px; margin-bottom: 6px">{{ selectedDoc.file }}</div>
                <iframe :src="selectedDocUrl" class="docFrame" />
              </div>
            </div>
            <div v-if="candidateModal.error" class="cm-error">{{ candidateModal.error }}</div>
          </div>

          <!-- Tab: Certificados -->
          <div v-else class="cm-tab-body">
            <div v-if="candidateModal.loadingDocs" class="cm-muted">Cargando…</div>
            <div v-else-if="!certDocs.length" class="cm-muted">(sin certificados)</div>
            <div v-else class="cm-stack">
              <div v-for="d in certDocs" :key="d.id" class="cm-doc-row">
                <div class="cm-row" style="justify-content: space-between; align-items: center">
                  <button class="cm-link" type="button" @click="candidateModal.selectedDocId=d.id">{{ d.file }}</button>
                  <div class="cm-row" style="gap: 6px">
                    <button class="cm-btn-sm" type="button" @click="candidateModal.selectedDocId=d.id">Preview</button>
                    <button class="cm-btn-sm" type="button" @click="openDoc(d)">Abrir</button>
                  </div>
                </div>
              </div>
              <div v-if="selectedDoc && selectedDoc.docType==='certificate'" class="cm-preview-wrap">
                <div class="cm-muted" style="font-size: 11px; margin-bottom: 6px">{{ selectedDoc.file }}</div>
                <iframe :src="selectedDocUrl" class="docFrame" />
              </div>
            </div>
            <div v-if="candidateModal.error" class="cm-error">{{ candidateModal.error }}</div>
          </div>
        </div>
      </div>

      <!-- Footer de acciones -->
      <div class="cm-footer">
        <div class="cm-row" style="gap: 8px">
          <button class="cm-btn-danger" type="button" :disabled="!candidateModal.applicationId" @click="hardDelete">Eliminar</button>
          <button class="cm-btn-ghost" type="button" :disabled="!candidateModal.applicationId" @click="exportZip">Exportar ZIP</button>
        </div>
        <div class="cm-row" style="gap: 8px">
          <button class="cm-btn-ghost" type="button" :disabled="!candidateModal.applicationId" @click="openHireModal">Marcar contratado</button>
        </div>
      </div>
    </ModalShell>

    <!-- Import modal (max 10) -->
    <ModalShell v-if="importModal.open" @close="closeImportModal">
      <template #title>Importar candidatos (máx 10)</template>

      <div class="stack" style="gap: 10px">
        <div class="card">
          <div style="font-weight: 650">Preview obligatorio</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            Puedes añadir manualmente o subir CVs. Si el nombre no se puede parsear del fichero, tendrás que rellenarlo.
          </div>
        </div>

        <div v-if="importModal.step==='edit'" class="stack" style="gap: 10px">
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button class="btn" type="button" @click="addImportRow" :disabled="importModal.rows.length>=10">Añadir fila</button>
            <label class="btn" style="display: inline-flex; align-items: center; gap: 8px">
              Subir CVs
              <input class="sr" type="file" multiple accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" @change="onPickImportCvs" />
            </label>
            <button class="btn" type="button" @click="toImportPreview" :disabled="!importModal.rows.length">Preview</button>
          </div>

          <div v-if="importModal.rows.length" class="stack" style="gap: 8px">
            <div v-for="(r,idx) in importModal.rows" :key="idx" class="card" style="background: var(--card2)">
              <div class="row" style="justify-content: space-between; align-items: center; gap: 10px">
                <div class="mono" style="font-size: 12px">#{{ idx+1 }}</div>
                <button class="btn" type="button" @click="removeImportRow(idx)">Quitar</button>
              </div>

              <div class="grid2" style="margin-top: 10px">
                <label class="field">
                  <span class="k">firstName</span>
                  <input class="in" v-model="r.firstName" maxlength="80" required />
                </label>
                <label class="field">
                  <span class="k">lastName</span>
                  <input class="in" v-model="r.lastName" maxlength="120" required />
                </label>
                <label class="field">
                  <span class="k">email</span>
                  <input class="in" type="email" v-model="r.email" maxlength="120" required />
                </label>
                <label class="field">
                  <span class="k">birthDate</span>
                  <input class="in" type="date" v-model="r.birthDate" required />
                </label>
              </div>

              <label class="field" style="margin-top: 10px">
                <span class="k">coverLetter</span>
                <textarea class="textarea" rows="3" v-model="r.coverLetter" maxlength="5000" required />
              </label>

              <div class="grid2" style="margin-top: 10px">
                <label class="field">
                  <span class="k">CV (obligatorio)</span>
                  <input
                    class="in"
                    type="file"
                    :data-import="`cv-${idx}`"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    @change="(e)=>onPickImportCv(idx,e)"
                    required
                  />
                  <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 6px">
                    <button class="btn" type="button" @click="attachDemoPdfAsCv(idx)">Usar demo CV</button>
                    <button class="btn" type="button" @click="attachDemoPdfAsCv(idx, 'Ana+Lopez+Martinez.pdf')">Demo CV (parseable)</button>
                  </div>
                  <div class="muted" style="font-size: 12px; margin-top: 6px">{{ r.cv?.name || '—' }}</div>
                </label>
                <label class="field">
                  <span class="k">Certificados (opcional)</span>
                  <input
                    class="in"
                    type="file"
                    multiple
                    :data-import="`certs-${idx}`"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    @change="(e)=>onPickImportCerts(idx,e)"
                  />
                  <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 6px">
                    <button class="btn" type="button" @click="attachDemoPdfAsCert(idx)">Añadir demo certificado</button>
                  </div>
                  <div class="muted" style="font-size: 12px; margin-top: 6px">{{ (r.certs||[]).length ? r.certs.map(f=>f.name).join(', ') : '—' }}</div>
                </label>
              </div>
            </div>
          </div>

          <div v-else class="card muted">Añade al menos 1 candidato.</div>
        </div>

        <div v-else class="stack" style="gap: 10px">
          <div class="card">
            <div style="font-weight: 650">Preview</div>
            <div class="muted" style="font-size: 12px; margin-top: 6px">Se importarán {{ importModal.rows.length }} candidatos en el listing.</div>
          </div>

          <div class="stack" style="gap: 8px">
            <div v-for="(p,idx) in importPreview" :key="idx" class="card" style="background: var(--card2)">
              <div style="font-weight: 650">#{{ idx+1 }} — {{ p.firstName || '—' }} {{ p.lastName || '' }}</div>
              <div class="muted" style="font-size: 12px; margin-top: 6px">{{ p.email || '—' }} · birthDate={{ p.birthDate || '—' }}</div>
              <div class="muted" style="font-size: 12px; margin-top: 6px">cv={{ p.cvName || '—' }} · certs={{ p.certCount }}</div>
              <div v-if="p.error" class="mono" style="margin-top: 6px; color: var(--danger)">{{ p.error }}</div>
            </div>
          </div>

          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button class="btn" type="button" @click="importModal.step='edit'" :disabled="importModal.loading">Volver</button>
            <button class="btn" type="button" @click="runImport" :disabled="importModal.loading || importPreviewHasErrors">
              {{ importModal.loading ? 'Importando…' : 'Importar definitivamente' }}
            </button>
          </div>

          <div v-if="importModal.results.length" class="card" style="background: var(--bg)">
            <div class="muted" style="font-size: 12px">Resultados (JSON)</div>
            <pre class="mono" style="font-size: 12px; white-space: pre-wrap; margin-top: 8px">{{ JSON.stringify(importModal.results, null, 2) }}</pre>
          </div>

          <div v-if="importModal.error" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
            <div class="mono">{{ importModal.error }}</div>
          </div>
        </div>
      </div>
    </ModalShell>

    <!-- Apply link modal -->
    <ModalShell v-if="applyLinkModal.open" @close="closeApplyLinkModal">
      <template #title>Generar link de aplicación (por candidatura)</template>

      <div class="stack" style="gap: 10px">
        <div class="card">
          <div style="font-weight: 650">Expiración (obligatoria)</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">Single-use. Rango permitido: 7–30 días.</div>
        </div>

        <div class="card stack" style="gap: 10px">
          <label class="field">
            <span class="k">Fecha final</span>
            <input class="in" type="date" v-model="applyLinkModal.expiresDate" :min="minExpiryDate" :max="maxExpiryDate" required />
            <div class="muted" style="font-size: 12px; margin-top: 6px">Mín: {{ minExpiryDate }} · Máx: {{ maxExpiryDate }}</div>
          </label>

          <div v-if="expiryRangeError" class="mono" style="color: var(--danger)">{{ expiryRangeError }}</div>

          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button class="btn" type="button" :disabled="applyLinkModal.loading || !!expiryRangeError" @click="generateApplyLink">
              {{ applyLinkModal.loading ? 'Generando…' : 'Generar link' }}
            </button>
            <button class="btn" type="button" :disabled="applyLinkModal.loading" @click="closeApplyLinkModal">Cerrar</button>
          </div>

          <div v-if="applyLinkModal.url" class="card" style="background: var(--card2)">
            <div class="muted" style="font-size: 12px">URL</div>
            <div class="mono" style="font-size: 12px; margin-top: 6px; word-break: break-all">{{ applyLinkModal.url }}</div>
            <div class="row" style="gap: 8px; margin-top: 10px">
              <button class="btn" type="button" @click="copyApplyUrl">Copiar</button>
              <button class="btn" type="button" @click="openApplyUrl">Abrir</button>
            </div>
          </div>

          <div v-if="applyLinkModal.error" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
            <div class="mono">{{ applyLinkModal.error }}</div>
          </div>
        </div>
      </div>
    </ModalShell>

    <!-- Hire modal (unchanged) -->
    <ModalShell v-if="hireModal.open" @close="closeHireModal">
      <template #title>Alta IT — Contratación</template>

      <div class="stack" style="gap: 10px">
        <div class="card">
          <div style="font-weight: 650">Datos de contratación</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            Departments/JobTitles SOLO se usan aquí (Alta IT), no en el pipeline.
          </div>
        </div>

        <div class="card stack" style="gap: 10px">
          <label class="field">
            <span class="k">Start date</span>
            <input class="in" type="date" v-model="hireModal.startDate" required />
          </label>

          <ComboBox label="Department" placeholder="Buscar department..." v-model="hireModal.department" :options="deptOptions" @search="loadDepartments" />

          <ComboBox label="Job Title" placeholder="Buscar job title..." v-model="hireModal.jobTitle" :options="jobTitleOptions" @search="loadJobTitles" />

          <label class="field">
            <span class="k">Cost center</span>
            <input class="in" v-model="hireModal.costCenter" placeholder="CC-123" required />
          </label>

          <label class="field">
            <span class="k">Manager email</span>
            <input class="in" type="email" v-model="hireModal.managerEmail" placeholder="manager@company.com" required />
          </label>

          <label class="field">
            <span class="k">Manager name (opcional)</span>
            <input class="in" v-model="hireModal.managerName" placeholder="Nombre Apellido" />
          </label>

          <label class="field">
            <span class="k">Access profile</span>
            <input class="in" v-model="hireModal.accessProfileId" placeholder="ACCESS-..." required />
          </label>

          <label class="field">
            <span class="k">Hardware profile (opcional)</span>
            <input class="in" v-model="hireModal.hardwareProfile" placeholder="Laptop / Mac / ..." />
          </label>

          <label class="field">
            <span class="k">Notas IT (opcional)</span>
            <textarea class="textarea" rows="3" v-model="hireModal.notesIT" placeholder="Notas para IT..." />
          </label>

          <div class="muted" style="font-size: 12px">{{ deptLoading || jobTitleLoading ? 'Cargando catálogos…' : '' }}</div>
        </div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn" type="button" :disabled="hireModal.loading" @click="confirmHire">{{ hireModal.loading ? 'Generando…' : 'Confirmar alta IT' }}</button>
          <button class="btn" type="button" :disabled="hireModal.loading" @click="closeHireModal">Cancelar</button>
        </div>

        <div v-if="hireModal.error" class="card" style="border-color: color-mix(in oklab, var(--danger) 50%, var(--line))">
          <div class="mono">{{ hireModal.error }}</div>
        </div>
      </div>
    </ModalShell>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

// (note) no new collections / no RBAC changes / no Alta IT changes
import { useRoute } from 'vue-router'
import { api, apiForm } from '../lib/api.js'
import { useAuthStore } from '../stores/auth.js'
import ModalShell from '../components/ModalShell.vue'
import ComboBox from '../components/ComboBox.vue'

const route = useRoute()
const auth = useAuthStore()

const stages = ['nuevo', 'revisar', 'entrevista', 'oferta', 'descartado', 'hired']

// selection is per listing (applicationId)
const stageLabel = { nuevo: 'Nuevo', revisar: 'Revisión', entrevista: 'Entrevista', oferta: 'Oferta', descartado: 'Descartado', hired: 'Contratado' }

const listings = ref([])
const appsByListing = reactive({})
const profiles = reactive({})

const openListingId = ref('')

// Selection is per listing (application)
const selectedAppByListing = reactive({})

function selectApplication(listingId, appRow) {
  const lid = String(listingId || '')
  if (!lid || !appRow?.id) return
  selectedAppByListing[lid] = appRow
}

const candidateModal = reactive({
  open: false,
  tab: 'datos',
  listingId: '',
  applicationId: '',
  application: null,
  candidateUserId: '',
  profile: null,
  docs: [],
  loadingDocs: false,
  selectedDocId: '',
  outboxId: '',
  // apply tokens are per application (candidatura)
  applyTokens: [],
  loadingTokens: false,
  error: '',
})

const applyLinkModal = reactive({
  open: false,
  listingId: '',
  applicationId: '',
  expiresDate: '', // YYYY-MM-DD (required)
  loading: false,
  url: '',
  error: '',
})

const deleteConfirm = reactive({
  open: false,
  loading: false,
  error: '',
  listingId: '',
  applicationId: '',
})

const hireModal = reactive({
  open: false,
  loading: false,
  error: '',
  applicationId: '',
  startDate: '',
  department: null,
  jobTitle: null,
  costCenter: '',
  managerEmail: '',
  managerName: '',
  accessProfileId: '',
  hardwareProfile: '',
  notesIT: '',
})

const deptOptions = ref([])

// ---- Import/Export (ATS refinamiento, FASE 5) ----

const importModal = reactive({
  open: false,
  step: 'edit', // edit | preview
  listingId: '',
  rows: [],
  loading: false,
  error: '',
  results: [],
})

const importPreview = computed(() => {
  return (importModal.rows || []).map((r) => {
    const firstName = String(r.firstName || '').trim()
    const lastName = String(r.lastName || '').trim()
    const email = String(r.email || '').trim()
    const birthDate = String(r.birthDate || '').trim()
    const coverLetter = String(r.coverLetter || '').trim()
    const cv = r.cv || null
    const certs = Array.isArray(r.certs) ? r.certs : []
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    for (const f of certs) {
      if (f && typeof f.size === 'number' && f.size > 50 * 1024 * 1024) error = error || 'Certificado supera 50MB'
      if (f && f.type && !allowed.includes(String(f.type))) error = error || 'Certificado: tipo no permitido'
    }

    let error = ''
    if (!firstName) error = error || 'Falta firstName'
    if (!lastName) error = error || 'Falta lastName'
    if (!email) error = error || 'Falta email'
    if (!birthDate) error = error || 'Falta birthDate'
    if (!coverLetter) error = error || 'Falta coverLetter'
    if (!cv) error = error || 'Falta CV'
    if (cv && typeof cv.size === 'number' && cv.size > 50 * 1024 * 1024) error = error || 'CV supera 50MB'
    if (cv && cv.type && ![
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(String(cv.type))) error = error || 'CV: tipo no permitido'

    return {
      firstName,
      lastName,
      email,
      birthDate,
      coverLetter,
      cvName: cv?.name || '',
      certCount: certs.length,
      error,
    }
  })
})

const importPreviewHasErrors = computed(() => importPreview.value.some((p) => !!p.error)) // preview validation

// (importPreview is used directly in template)

function openImportModal(listingId) {
  importModal.open = true
  importModal.step = 'edit'
  importModal.listingId = String(listingId || '')
  importModal.rows = []
  importModal.loading = false
  importModal.error = ''
  importModal.results = []
  addImportRow()
}

function closeImportModal() {
  importModal.open = false
  importModal.step = 'edit'
  importModal.listingId = ''
  importModal.rows = []
  importModal.loading = false
  importModal.error = ''
  importModal.results = []
}

function addImportRow(prefill = {}) {
  if (importModal.rows.length >= 10) return
  importModal.rows.push({
    firstName: prefill.firstName || '',
    lastName: prefill.lastName || '',
    email: prefill.email || '',
    birthDate: prefill.birthDate || '',
    coverLetter: prefill.coverLetter || '',
    cv: prefill.cv || null,
    certs: prefill.certs || [],
  })
}

function removeImportRow(idx) {
  importModal.rows.splice(idx, 1)
}

function parseNameFromFilename(name) {
  // ONLY if filename matches: Nombre+Apellido+Apellido2.(pdf|doc|docx)
  const s = String(name || '').trim()
  const m = s.match(/^([^+]+)\+([^+]+)\+([^+.]+)\.(pdf|doc|docx)$/i)
  if (!m) return { firstName: '', lastName: '' }

  const firstName = String(m[1] || '').trim()
  const lastName = [m[2], m[3]].map((x) => String(x || '').trim()).filter(Boolean).join(' ').trim()
  if (!firstName || !lastName) return { firstName: '', lastName: '' }
  return { firstName, lastName }
}

function onPickImportCvs(ev) {
  const files = Array.from(ev?.target?.files || [])
  ev.target.value = ''
  for (const f of files) {
    if (importModal.rows.length >= 10) break

    const parsed = parseNameFromFilename(f?.name)
    addImportRow({
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      cv: f,
      coverLetter: 'Import interno (FASE 5).',
    })
  }
}

function onPickImportCv(idx, ev) {
  const f = ev?.target?.files?.[0] || null
  importModal.rows[idx].cv = f

  // If filename matches strict pattern and fields are empty, prefill.
  if (f?.name) {
    const parsed = parseNameFromFilename(f.name)
    if (parsed.firstName && !String(importModal.rows[idx].firstName || '').trim()) importModal.rows[idx].firstName = parsed.firstName
    if (parsed.lastName && !String(importModal.rows[idx].lastName || '').trim()) importModal.rows[idx].lastName = parsed.lastName
  }
}

function onPickImportCerts(idx, ev) {
  const list = Array.from(ev?.target?.files || [])
  importModal.rows[idx].certs = list
}

function toImportPreview() {
  importModal.error = ''
  importModal.step = 'preview'
}

async function fetchDemoPdfBlob() {
  const res = await fetch('/demo-cv.pdf')
  if (!res.ok) throw new Error(`demo pdf fetch failed: ${res.status}`)
  return await res.blob()
}

async function attachDemoPdfAsCv(idx, filename) {
  importModal.error = ''
  try {
    const blob = await fetchDemoPdfBlob()
    const name = String(filename || 'demo-cv.pdf')
    const file = new File([blob], name, { type: 'application/pdf' })
    importModal.rows[idx].cv = file

    // apply strict parse if matches
    const parsed = parseNameFromFilename(name)
    if (parsed.firstName && !String(importModal.rows[idx].firstName || '').trim()) importModal.rows[idx].firstName = parsed.firstName
    if (parsed.lastName && !String(importModal.rows[idx].lastName || '').trim()) importModal.rows[idx].lastName = parsed.lastName
  } catch (e) {
    importModal.error = String(e?.message || e)
  }
}

async function attachDemoPdfAsCert(idx, filename) {
  importModal.error = ''
  try {
    const blob = await fetchDemoPdfBlob()
    const name = String(filename || 'certificado-demo.pdf')
    const file = new File([blob], name, { type: 'application/pdf' })
    const list = Array.isArray(importModal.rows[idx].certs) ? importModal.rows[idx].certs : []
    importModal.rows[idx].certs = [...list, file]
  } catch (e) {
    importModal.error = String(e?.message || e)
  }
}

function safeCvFilename(r) {
  const fn = String(r.firstName || '').trim().replace(/\s+/g, '+')
  const ln = String(r.lastName || '').trim().replace(/\s+/g, '+')
  const orig = String(r.cv?.name || 'cv.pdf')
  const ext = orig.includes('.') ? orig.split('.').pop() : 'pdf'
  const base = `${fn}+${ln}`.replace(/[^a-zA-Z0-9+_-]+/g, '+')
  return `${base}.${ext}`
}

async function runImport() {
  importModal.error = ''
  importModal.results = []
  if (importPreviewHasErrors.value) return (importModal.error = 'Hay errores en el preview.')
  if (!importModal.listingId) return (importModal.error = 'Falta listingId.')

  importModal.loading = true
  try {
    for (const r of importModal.rows) {
      const fd = new FormData()
      fd.set('firstName', String(r.firstName || '').trim())
      fd.set('lastName', String(r.lastName || '').trim())
      fd.set('email', String(r.email || '').trim())
      fd.set('birthDate', String(r.birthDate || '').trim())
      fd.set('coverLetter', String(r.coverLetter || '').trim())

      const cvName = safeCvFilename(r)
      fd.set('cv', r.cv, cvName)

      for (const f of r.certs || []) fd.append('certificates', f)

      const res = await apiForm(`/interno/listings/${encodeURIComponent(importModal.listingId)}/import_candidate`, fd) //Fallo de seguridad aquí rce
      importModal.results.push({ ok: true, inputEmail: r.email, res })
      console.log('[import_candidate] ok', { inputEmail: r.email, res })
    }

    // Refresh UI (no F5)
    await loadApplications(importModal.listingId)

    // Keep modal open to show evidence (results). User can close manually.
    importModal.step = 'preview'
  } catch (e) {
    importModal.error = String(e?.message || e)
    importModal.results.push({ ok: false, error: importModal.error })
    console.log('[import_candidate] error', importModal.error)
  } finally {
    importModal.loading = false
  }
}

function exportListingZip(listingId) {
  const url = `/api/interno/listings/${encodeURIComponent(String(listingId || ''))}/export.zip`
  window.open(url, '_blank', 'noopener,noreferrer')
}
const deptLoading = ref(false)
async function loadDepartments(q) {
  deptLoading.value = true
  try {
    const qs = new URLSearchParams({ q: q || '', active: '1' }).toString()
    const res = await api(`/interno/departments?${qs}`)
    deptOptions.value = (res.items || []).map((d) => ({ id: d.id, code: d.code, name: d.name }))
  } catch {
    deptOptions.value = []
  } finally {
    deptLoading.value = false
  }
}

const jobTitleOptions = ref([])
const jobTitleLoading = ref(false)
async function loadJobTitles(q) {
  jobTitleLoading.value = true
  try {
    const qs = new URLSearchParams({ q: q || '', active: '1' }).toString()
    const res = await api(`/interno/job_titles?${qs}`)
    jobTitleOptions.value = (res.items || []).map((d) => ({ id: d.id, code: d.code, name: d.name }))
  } catch {
    jobTitleOptions.value = []
  } finally {
    jobTitleLoading.value = false
  }
}

async function loadListings() {
  const res = await api('/listings')
  listings.value = res.items || []
}

const companyListings = computed(() => (listings.value || []).filter((l) => l.kind === 'empleo'))

function pickInitialOpen() {
  const q = route.query?.listingId
  const qid = typeof q === 'string' ? q : ''
  const exists = qid && companyListings.value.some((l) => l.id === qid)
  if (exists) return qid
  return companyListings.value[0]?.id || ''
}

watch(
  () => [companyListings.value.length, route.query?.listingId],
  () => {
    if (!openListingId.value) openListingId.value = pickInitialOpen()
    const q = route.query?.listingId
    const qid = typeof q === 'string' ? q : ''
    if (qid && companyListings.value.some((l) => l.id === qid)) openListingId.value = qid
  },
  { immediate: true }
)

const autoRefresh = reactive({ timer: null, listingId: '', intervalMs: 3000 })

function stopAutoRefresh() {
  if (autoRefresh.timer) clearInterval(autoRefresh.timer)
  autoRefresh.timer = null
  autoRefresh.listingId = ''
}

function startAutoRefresh(listingId) {
  stopAutoRefresh()
  if (!listingId) return

  autoRefresh.listingId = listingId
  autoRefresh.timer = setInterval(() => {
    // Avoid aggressive refresh when tab is not visible.
    if (document?.visibilityState && document.visibilityState !== 'visible') return
    loadApplications(listingId).catch(() => {})
  }, autoRefresh.intervalMs)
}

watch(
  () => openListingId.value,
  (id) => {
    stopAutoRefresh()
    if (!id) return
    if (!companyListings.value.some((l) => l.id === id)) return

    // Always refresh once when opening (covers "apply" just happened in another tab)
    loadApplications(id).catch(() => {})
    startAutoRefresh(id)
  },
  { immediate: true }
)

const appsLoading = reactive({})

async function loadApplications(listingId) {
  if (!listingId) return
  if (appsLoading[listingId]) return

  appsLoading[listingId] = true
  try {
    const res = await api(`/company/listings/${encodeURIComponent(listingId)}/applications`)
    appsByListing[listingId] = res.items || []

    // Load candidate_profiles (firstName/lastName/email) for cards + modal.
    const missing = Array.from(
      new Set(
        (appsByListing[listingId] || [])
          .map((a) => a?.candidateUserId)
          .filter((cid) => cid && profiles[cid] === undefined)
      )
    )

    await Promise.all(
      missing.map(async (cid) => {
        try {
          const p = await api(`/company/candidates/${encodeURIComponent(cid)}/profile`)
          profiles[cid] = p.profile || null
        } catch {
          profiles[cid] = null
        }
      })
    )
  } finally {
    appsLoading[listingId] = false
  }
}

function toggleOpen(listingId) {
  openListingId.value = openListingId.value === listingId ? '' : listingId
  if (openListingId.value) loadApplications(openListingId.value)
}

function appsByStage(listingId) {
  const map = Object.fromEntries(stages.map((s) => [s, []]))
  const list = Array.isArray(appsByListing[listingId]) ? appsByListing[listingId] : []
  for (const a of list) map[a.stage]?.push(a)
  return map
}

function fullName(p) {
  const fn = String(p?.firstName || '').trim()
  const ln = String(p?.lastName || '').trim()
  const both = [fn, ln].filter(Boolean).join(' ').trim()
  return both
}

function candName(app) {
  const cid = app?.candidateUserId
  const p = cid ? profiles[cid] : null
  const name = fullName(p)
  if (name) return name
  if (p?.email) return p.email
  if (cid) return cid
  return '(pendiente)'
}

function candMeta(app) {
  const cid = app?.candidateUserId
  const p = cid ? profiles[cid] : null
  return p?.email || '—'
}

function fmtDate(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  return s.slice(0, 10)
}

function stageOrder(stage) {
  return stages.indexOf(String(stage || ''))
}

const cvDocs = computed(() => (candidateModal.docs || []).filter((d) => d.docType === 'cv'))
const certDocs = computed(() => (candidateModal.docs || []).filter((d) => d.docType === 'certificate'))

const selectedDoc = computed(() => (candidateModal.docs || []).find((d) => d.id === candidateModal.selectedDocId) || null)
const selectedDocUrl = computed(() => {
  if (!candidateModal.applicationId || !selectedDoc.value?.id) return ''
  return `/api/interno/applications/${encodeURIComponent(candidateModal.applicationId)}/documents/${encodeURIComponent(selectedDoc.value.id)}`
})

async function loadDocs(applicationId) {
  candidateModal.loadingDocs = true
  try {
    const res = await api(`/interno/applications/${encodeURIComponent(applicationId)}/documents`)
    candidateModal.docs = res.items || []
  } catch {
    candidateModal.docs = []
  } finally {
    candidateModal.loadingDocs = false
  }
}

const latestApplyToken = computed(() => {
  const items = Array.isArray(candidateModal.applyTokens) ? candidateModal.applyTokens : []
  return items[0] || null
})

function tokenStatus(t) {
  if (!t) return ''
  if (t.usedAt) return 'usado'
  const expMs = Date.parse(String(t.expiresAt || ''))
  if (Number.isFinite(expMs) && Date.now() > expMs) return 'expirado'
  if (t.active === false) return 'inactivo'
  return 'activo'
}

async function loadApplyTokens(applicationId) {
  candidateModal.loadingTokens = true
  try {
    const res = await api(`/interno/applications/${encodeURIComponent(applicationId)}/apply_tokens`)
    candidateModal.applyTokens = res.items || []
  } catch {
    candidateModal.applyTokens = []
  } finally {
    candidateModal.loadingTokens = false
  }
}

async function openCandidateModal(listingId, appRow) {
  candidateModal.open = true
  candidateModal.tab = 'datos'
  candidateModal.listingId = String(listingId || '')
  candidateModal.applicationId = String(appRow?.id || '')
  candidateModal.application = appRow || null
  candidateModal.candidateUserId = String(appRow?.candidateUserId || '')
  candidateModal.profile = candidateModal.candidateUserId ? profiles[candidateModal.candidateUserId] || null : null
  candidateModal.docs = []
  candidateModal.selectedDocId = ''
  candidateModal.outboxId = ''
  candidateModal.applyTokens = []
  candidateModal.loadingTokens = false
  candidateModal.error = ''

  if (candidateModal.candidateUserId && !candidateModal.profile) {
    try {
      const p = await api(`/company/candidates/${encodeURIComponent(candidateModal.candidateUserId)}/profile`)
      candidateModal.profile = p.profile || null
      profiles[candidateModal.candidateUserId] = candidateModal.profile
    } catch {
      candidateModal.profile = null
    }
  }

  if (candidateModal.applicationId) {
    await Promise.all([loadDocs(candidateModal.applicationId), loadApplyTokens(candidateModal.applicationId)]).catch(() => {})
  }
}

async function toggleCandidateModal(listingId, appRow) {
  const lid = String(listingId || '')
  const appId = String(appRow?.id || '')
  if (!lid || !appId) return

  if (candidateModal.open && candidateModal.applicationId === appId) return closeCandidateModal()
  return openCandidateModal(lid, appRow)
}

function closeCandidateModal() {
  candidateModal.open = false
  candidateModal.tab = 'datos'
  candidateModal.listingId = ''
  candidateModal.applicationId = ''
  candidateModal.application = null
  candidateModal.candidateUserId = ''
  candidateModal.profile = null
  candidateModal.docs = []
  candidateModal.loadingDocs = false
  candidateModal.selectedDocId = ''
  candidateModal.outboxId = ''
  candidateModal.applyTokens = []
  candidateModal.loadingTokens = false
  candidateModal.error = ''
}

function openDoc(d) {
  if (!candidateModal.applicationId) return
  const url = `/api/interno/applications/${encodeURIComponent(candidateModal.applicationId)}/documents/${encodeURIComponent(d.id)}`
  window.open(url, '_blank', 'noopener,noreferrer')
}

function exportZip() {
  if (!candidateModal.applicationId) return
  const url = `/api/interno/applications/${encodeURIComponent(candidateModal.applicationId)}/export.zip`
  window.open(url, '_blank', 'noopener,noreferrer')
}

function openDeleteConfirm(listingId, appRow) {
  deleteConfirm.open = true
  deleteConfirm.loading = false
  deleteConfirm.error = ''
  deleteConfirm.listingId = String(listingId || '')
  deleteConfirm.applicationId = String(appRow?.id || '')
}

function closeDeleteConfirm() {
  deleteConfirm.open = false
  deleteConfirm.loading = false
  deleteConfirm.error = ''
  deleteConfirm.listingId = ''
  deleteConfirm.applicationId = ''
}

async function confirmHardDelete() {
  deleteConfirm.error = ''
  if (!deleteConfirm.applicationId) return (deleteConfirm.error = 'Falta applicationId')

  deleteConfirm.loading = true
  try {
    const lid = deleteConfirm.listingId

    // Optimistic remove (no F5)
    if (lid && Array.isArray(appsByListing[lid])) {
      appsByListing[lid] = appsByListing[lid].filter((x) => x.id !== deleteConfirm.applicationId)
    }

    await api(`/company/applications/${encodeURIComponent(deleteConfirm.applicationId)}`, { method: 'DELETE' })

    if (lid) await loadApplications(lid)

    if (candidateModal.open && candidateModal.applicationId === deleteConfirm.applicationId) closeCandidateModal()

    closeDeleteConfirm()
  } catch (e) {
    deleteConfirm.error = String(e?.message || e)
    if (deleteConfirm.listingId) await loadApplications(deleteConfirm.listingId).catch(() => {})
  } finally {
    deleteConfirm.loading = false
  }
}

async function hardDelete() {
  if (!candidateModal.applicationId) return
  openDeleteConfirm(candidateModal.listingId, { id: candidateModal.applicationId })
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10)
}

function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + Number(days || 0))
  return d
}

const minExpiryDate = computed(() => isoDate(addDays(Date.now(), 7)))
const maxExpiryDate = computed(() => isoDate(addDays(Date.now(), 30)))

const expiryRangeError = computed(() => {
  const s = String(applyLinkModal.expiresDate || '').trim()
  if (!s) return 'Selecciona fecha de expiración.'
  if (s < minExpiryDate.value) return `La expiración mínima es ${minExpiryDate.value} (7 días).`
  if (s > maxExpiryDate.value) return `La expiración máxima es ${maxExpiryDate.value} (30 días).`
  return ''
})

function openApplyLinkModal(listingId, applicationId) {
  // (note) template might pass an event if used as @click without args
  if (listingId && typeof listingId === 'object') listingId = ''

  applyLinkModal.open = true
  applyLinkModal.listingId = String(listingId || candidateModal.listingId || '')
  applyLinkModal.applicationId = String(applicationId || candidateModal.applicationId || selectedAppByListing[applyLinkModal.listingId]?.id || '')
  applyLinkModal.expiresDate = ''
  applyLinkModal.loading = false
  applyLinkModal.url = ''
  applyLinkModal.error = ''
}

function closeApplyLinkModal() {
  applyLinkModal.open = false
  applyLinkModal.listingId = ''
  applyLinkModal.applicationId = ''
  applyLinkModal.expiresDate = ''
  applyLinkModal.loading = false
  applyLinkModal.url = ''
  applyLinkModal.error = ''
}

async function generateApplyLink() {
  applyLinkModal.error = ''
  applyLinkModal.url = ''
  if (!applyLinkModal.applicationId) return (applyLinkModal.error = 'Falta applicationId')

  const rangeErr = expiryRangeError.value
  if (rangeErr) return (applyLinkModal.error = rangeErr)

  // Date picker provides YYYY-MM-DD (local). Use end-of-day local to be intuitive.
  const dt = new Date(`${applyLinkModal.expiresDate}T23:59:59`)
  const expiresAt = dt.toISOString()

  applyLinkModal.loading = true
  try {
    const res = await api('/interno/apply_tokens', {
      method: 'POST',
      body: JSON.stringify({ applicationId: applyLinkModal.applicationId, expiresAt }),
    })
    const full = `${window.location.origin}${res.applyUrl}`
    applyLinkModal.url = full
    if (applyLinkModal.applicationId) await loadApplyTokens(applyLinkModal.applicationId).catch(() => {})
  } catch (e) {
    applyLinkModal.error = String(e?.message || e)
  } finally {
    applyLinkModal.loading = false
  }
}

async function copyApplyUrl() {
  try {
    await navigator.clipboard.writeText(applyLinkModal.url)
  } catch {
    // fallback
    prompt('Copia la URL:', applyLinkModal.url)
  }
}

function openApplyUrl() {
  if (!applyLinkModal.url) return
  window.open(applyLinkModal.url, '_blank', 'noopener,noreferrer')
}

// Hiring modal (existing)
async function openHireModal() {
  if (!candidateModal.applicationId) return
  hireModal.open = true
  hireModal.loading = false
  hireModal.error = ''
  hireModal.applicationId = candidateModal.applicationId
  hireModal.startDate = new Date().toISOString().slice(0, 10)
  hireModal.department = null
  hireModal.jobTitle = null
  hireModal.costCenter = ''
  hireModal.managerEmail = ''
  hireModal.managerName = ''
  hireModal.accessProfileId = ''
  hireModal.hardwareProfile = ''
  hireModal.notesIT = ''
  await Promise.all([loadDepartments(''), loadJobTitles('')]).catch(() => {})
}

function closeHireModal() {
  hireModal.open = false
}

async function confirmHire() {
  hireModal.error = ''
  if (!hireModal.applicationId) return (hireModal.error = 'Falta applicationId.')
  if (!hireModal.startDate) return (hireModal.error = 'Falta startDate.')
  if (!hireModal.department?.id) return (hireModal.error = 'Selecciona Department.')
  if (!hireModal.jobTitle?.id) return (hireModal.error = 'Selecciona Job Title.')
  if (!String(hireModal.costCenter || '').trim()) return (hireModal.error = 'Falta costCenter.')
  if (!String(hireModal.managerEmail || '').trim()) return (hireModal.error = 'Falta managerEmail.')
  if (!String(hireModal.accessProfileId || '').trim()) return (hireModal.error = 'Falta accessProfileId.')

  hireModal.loading = true
  try {
    const res = await api('/interno/hire/enqueue_it_request', {
      method: 'POST',
      body: JSON.stringify({
        applicationId: hireModal.applicationId,
        startDate: hireModal.startDate,
        departmentId: hireModal.department.id,
        jobTitleId: hireModal.jobTitle.id,
        costCenter: hireModal.costCenter,
        managerEmail: hireModal.managerEmail,
        managerName: hireModal.managerName,
        accessProfileId: hireModal.accessProfileId,
        hardwareProfile: hireModal.hardwareProfile,
        notesIT: hireModal.notesIT,
      }),
    })

    candidateModal.outboxId = res.outbox?.id || ''

    if (candidateModal.listingId) await loadApplications(candidateModal.listingId)

    closeHireModal()
  } catch (e) {
    hireModal.error = String(e?.message || e)
  } finally {
    hireModal.loading = false
  }
}

// drag & drop
const drag = reactive({ listingId: '', appId: '', fromStage: '' })
const over = reactive({ listingId: '', stage: '' })

function onDragStart(listingId, appId, stage, ev) {
  drag.listingId = listingId
  drag.appId = appId
  drag.fromStage = stage
  try {
    if (ev?.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', `${listingId}:${appId}`)
    }
  } catch {}
}

function onDragEnd() {
  drag.listingId = ''
  drag.appId = ''
  drag.fromStage = ''
  over.listingId = ''
  over.stage = ''
}

function onDragEnter(listingId, stage) {
  if (!drag.appId) return
  if (drag.listingId !== listingId) return
  over.listingId = listingId
  over.stage = stage
}

function onDragLeave(listingId, stage) {
  if (over.listingId === listingId && over.stage === stage) {
    over.listingId = ''
    over.stage = ''
  }
}

async function onDrop(listingId, stage) {
  if (!drag.appId) return
  if (drag.listingId !== listingId) return
  if (drag.fromStage === stage) return onDragEnd()

  await api(`/company/applications/${encodeURIComponent(drag.appId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ stage }),
  })

  await loadApplications(listingId)
  onDragEnd()
}

// notes
const notesUi = reactive({ appId: '', open: false })
function openNotes(appId) {
  notesUi.open = true
  notesUi.appId = appId
}
function closeNotes() {
  notesUi.open = false
  notesUi.appId = ''
}
function notesPreview(notes) {
  const t = String(notes || '').trim()
  if (!t) return '(sin notas)'
  const one = t.split(/\r?\n/)[0]
  return one.length > 60 ? one.slice(0, 60) + '…' : one
}

let notesTimer = null
function setNotes(appId, val) {
  const listingId = openListingId.value
  if (!listingId) return
  const list = appsByListing[listingId] || []
  const row = list.find((x) => x.id === appId)
  if (row) row.notes = val

  clearTimeout(notesTimer)
  notesTimer = setTimeout(async () => {
    await api(`/company/applications/${encodeURIComponent(appId)}`, { method: 'PATCH', body: JSON.stringify({ notes: val }) })
  }, 400)
}

onMounted(async () => {
  await auth.bootstrap()
  await loadListings().catch(() => {})
})

onBeforeUnmount(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.accHead {
  width: 100%;
  text-align: left;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  padding: 12px;
  cursor: pointer;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: start;
}

.accHead:hover {
  border-color: var(--line2);
}

.accBody {
  margin-top: 10px;
}

.cols {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.col {
  border: 1px solid var(--line);
  background: var(--card2);
  padding: 10px;
}

.col[data-dnd='true'] {
  border-color: var(--line2);
}

.col[data-over='true'] {
  border-color: var(--line2);
  background: color-mix(in oklab, var(--card2) 70%, var(--bg));
}

.colHead {
  font-weight: 650;
  margin-bottom: 10px;
}

.cand {
  border: 1px solid var(--line);
  background: var(--card);
  padding: 10px;
  display: grid;
  gap: 8px;
  cursor: grab;
  position: relative;
}

.cand:active {
  cursor: grabbing;
}

.cand[data-dragging='true'] {
  opacity: 0.5;
  border-color: var(--line2);
  background: color-mix(in oklab, var(--card) 75%, var(--bg));
}

.expbtn, .delbtn {
  position: absolute;
  right: 6px;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 1;
  font-size: 14px;
  opacity: 0.75;
}

.expbtn {
  top: 6px;
}

.delbtn {
  top: 32px;
  font-size: 13px;
}

.expbtn:hover {
  opacity: 1;
  border-color: var(--line2);
}

.delbtn:hover {
  opacity: 1;
  border-color: color-mix(in oklab, var(--danger) 60%, var(--line2));
}

.expbtn:active, .delbtn:active {
  transform: translateY(1px);
}

.notesPreview {
  width: 100%;
  text-align: left;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  padding: 8px;
}

.notesPreview:hover {
  border-color: var(--line2);
}

.cand .textarea {
  min-height: 68px;
  resize: vertical;
}

.btn[data-active='true'] {
  border-color: var(--line2);
  background: color-mix(in oklab, var(--card) 70%, var(--bg));
}

.btn.danger {
  border-color: color-mix(in oklab, var(--danger) 60%, var(--line));
}

.link {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.link:hover {
  text-decoration: underline;
}

.docFrame {
  width: 100%;
  height: 60vh;
  border: 1px solid var(--line);
  background: white;
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 1100px) {
  .cols {
    grid-template-columns: 1fr;
  }
}

/* ── Candidate modal ── */
.cm-layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 0;
  border: 1px solid var(--line);
  min-height: 420px;
}

.cm-aside {
  border-right: 1px solid var(--line);
  background: var(--card2);
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.cm-profile-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.cm-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: color-mix(in oklab, var(--line2) 30%, var(--card));
  border: 1px solid var(--line2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 16px;
  flex-shrink: 0;
}

.cm-name {
  font-weight: 650;
  font-size: 13px;
  line-height: 1.3;
}

.cm-stage-badge {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 7px;
  border: 1px solid var(--line2);
  font-size: 11px;
  color: var(--muted);
}

.cm-sep {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 12px 0;
}

.cm-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cm-section-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 4px;
}

.cm-info-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cm-info-label {
  font-size: 10px;
  color: var(--muted);
}

.cm-info-val {
  font-size: 12px;
  word-break: break-all;
}

.cm-doc-row {
  border: 1px solid var(--line);
  padding: 8px;
  background: var(--card);
}

.cm-doc-name {
  font-size: 11px;
  color: var(--muted);
  word-break: break-all;
}

.cm-muted {
  font-size: 12px;
  color: var(--muted);
}

.cm-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cm-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.cm-btn-sm {
  padding: 4px 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.cm-btn-sm:hover {
  border-color: var(--line2);
}

.cm-btn-sm:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Main panel */
.cm-main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cm-tabs {
  display: flex;
  border-bottom: 1px solid var(--line);
}

.cm-tab {
  padding: 10px 14px;
  border: 0;
  border-right: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.cm-tab:hover {
  color: var(--ink);
}

.cm-tab-active {
  color: var(--ink);
  background: color-mix(in oklab, var(--card) 60%, var(--bg));
  border-bottom: 2px solid var(--line2);
}

.cm-tab-body {
  padding: 16px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Timeline */
.cm-timeline {
  display: flex;
  flex-direction: column;
  gap: 0;
  position: relative;
  padding-left: 28px;
}

.cm-tl-item {
  position: relative;
  padding: 0 0 16px 12px;
  border-left: 1px solid var(--line);
}

.cm-tl-item:last-child {
  border-left-color: transparent;
  padding-bottom: 0;
}

.cm-tl-dot {
  position: absolute;
  left: -6px;
  top: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid var(--line2);
  background: var(--bg);
}

.cm-tl-done .cm-tl-dot {
  background: var(--line2);
  border-color: var(--line2);
}

.cm-tl-current .cm-tl-dot {
  background: var(--ink);
  border-color: var(--ink);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ink) 20%, transparent);
}

.cm-tl-pending .cm-tl-dot {
  background: var(--bg);
  opacity: 0.4;
}

.cm-tl-label {
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
}

.cm-tl-pending .cm-tl-label {
  color: var(--muted);
  font-weight: 400;
}

.cm-tl-note {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  border-left: 2px solid var(--line);
  padding-left: 8px;
  font-style: italic;
}

.cm-cover {
  font-size: 13px;
  white-space: pre-wrap;
  color: var(--muted);
  border: 1px solid var(--line);
  padding: 10px;
  background: var(--card2);
}

.cm-outbox {
  border: 1px solid var(--line);
  padding: 10px;
  background: var(--card2);
}

.cm-preview-wrap {
  margin-top: 8px;
}

.cm-link {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.cm-error {
  font-size: 12px;
  border: 1px solid color-mix(in oklab, var(--danger) 50%, var(--line));
  padding: 8px;
  color: color-mix(in oklab, var(--danger) 70%, var(--ink));
}

/* Footer */
.cm-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: var(--card2);
}

.cm-btn-ghost {
  padding: 7px 12px;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.cm-btn-ghost:hover {
  border-color: var(--line2);
}

.cm-btn-ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cm-btn-danger {
  padding: 7px 12px;
  border: 1px solid color-mix(in oklab, var(--danger) 50%, var(--line));
  background: transparent;
  color: color-mix(in oklab, var(--danger) 70%, var(--ink));
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.cm-btn-danger:hover {
  border-color: var(--danger);
}

.cm-btn-danger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 700px) {
  .cm-layout {
    grid-template-columns: 1fr;
  }
  .cm-aside {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
</style>
