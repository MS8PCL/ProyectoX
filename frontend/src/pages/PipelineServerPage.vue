<template>
  <div class="stack">
    <!-- Header glass -->
    <div class="card-glass stack" style="gap: 12px">
      <div class="row justify-between items-center">
        <div>
          <h2 class="text-lg font-bold" style="margin: 0">{{ t('pipeline.title') }}</h2>
          <p class="muted text-sm mt-4">{{ isDesktop() ? t('pipeline.subtitleShared') : t('pipeline.subtitle') }}</p>
        </div>
        <div class="row items-center gap-8">
          <span class="badge">{{ activeFilterCount ? `${filteredTotalCandidates} de ${totalCandidates} ${t('pipeline.candidates')}` : `${totalCandidates} ${t('pipeline.candidates')}` }}</span>
        </div>
      </div>
    </div>

    <div v-if="documentActionError" class="card muted" role="alert">{{ documentActionError }}</div>
    <div v-if="loadError" class="card" role="alert" style="border-color: var(--color-danger)">{{ t('pipeline.loadError') }}: {{ loadError }}</div>

        <div v-if="!['admin','rrhh','it'].includes(auth.user?.role)" class="card muted">
      {{ t('pipeline.internalOnly') }}
    </div>

    <div v-else class="stack">
      <!-- Advanced Filters Panel -->
      <div class="card stack" style="gap: 12px">
        <button
        class="btn btn-ghost btn-sm row items-center gap-8"
        type="button"
        @click="filtersOpen = !filtersOpen"
      >
        <Filter :size="14" />
        <span>{{ t('pipeline.filters') }}</span>
        <span v-if="activeFilterCount" class="badge badge-info" style="font-size: 11px; padding: 2px 6px">{{ activeFilterCount }}</span>
        <component :is="filtersOpen ? ChevronUp : ChevronDown" :size="14" />
      </button>

      <div v-if="filtersOpen" class="stack" style="gap: 12px">
        <!-- Stage checkboxes -->
        <div class="stack gap-4">
          <label class="muted text-sm font-semibold">{{ t('pipeline.stage') }}</label>
          <div class="row-wrap gap-8">
            <label
              v-for="s in stages"
              :key="s"
              class="row items-center gap-8 cursor-pointer"
              style="padding: 4px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-base); font-size: 13px"
              :style="{ background: filterStages.has(s) ? (stageColor[s] + '22') : 'transparent', borderColor: filterStages.has(s) ? stageColor[s] : 'var(--color-border)' }"
            >
              <input type="checkbox" :checked="filterStages.has(s)" @change="toggleStage(s)" style="accent-color: var(--color-accent)" />
              {{ stageLabel[s] }}
            </label>
          </div>
        </div>

        <!-- Skills -->
        <div class="stack gap-4" style="max-width: 340px">
          <label class="muted text-sm font-semibold">{{ t('pipeline.skills') }}</label>
          <input
            class="input"
            type="text"
            :value="filterSkillsInput"
            @input="onSkillsInput"
            :placeholder="t('pipeline.skillsPlaceholder') || 'Ej: react, python, leadership...'"
          />
        </div>

        <!-- Location -->
        <div class="stack gap-4" style="max-width: 340px">
          <label class="muted text-sm font-semibold">{{ t('pipeline.location') }}</label>
          <input
            class="input"
            type="text"
            :value="filterLocationInput"
            @input="onLocationInput"
            :placeholder="'Ej: Madrid, remoto...'"
          />
        </div>

        <!-- Salary range -->
        <div class="row gap-8 items-center flex-wrap">
          <div class="stack gap-4" style="max-width: 160px">
            <label class="muted text-sm font-semibold">{{ t('pipeline.salaryMin') }}</label>
            <input
              class="input"
              type="number"
              :value="filterSalaryMin"
              @input="onSalaryMinInput"
              placeholder="20000"
              min="0"
            />
          </div>
          <div class="stack gap-4" style="max-width: 160px">
            <label class="muted text-sm font-semibold">{{ t('pipeline.salaryMax') }}</label>
            <input
              class="input"
              type="number"
              :value="filterSalaryMax"
              @input="onSalaryMaxInput"
              placeholder="80000"
              min="0"
            />
          </div>
        </div>

        <!-- Date range -->
        <div class="row gap-8 items-center flex-wrap">
          <div class="stack gap-4" style="max-width: 160px">
            <label class="muted text-sm font-semibold">{{ t('pipeline.dateFrom') }}</label>
            <input class="input" type="date" :value="filterDateFrom" @input="onDateFromInput" />
          </div>
          <div class="stack gap-4" style="max-width: 160px">
            <label class="muted text-sm font-semibold">{{ t('pipeline.dateTo') }}</label>
            <input class="input" type="date" :value="filterDateTo" @input="onDateToInput" />
          </div>
        </div>
      </div>

      <!-- Active filter badges -->
      <div v-if="activeFilterBadges.length" class="row-wrap gap-8" style="margin-top: 4px">
        <span
          v-for="b in activeFilterBadges"
          :key="b.key"
          class="badge badge-info row items-center gap-8"
        >
          {{ b.label }}
          <button
            type="button"
            @click="removeFilter(b.key)"
            style="background: none; border: none; color: inherit; cursor: pointer; padding: 0; font-size: 14px; line-height: 1"
          >&times;</button>
        </span>
        <button v-if="activeFilterBadges.length" class="btn btn-ghost btn-sm" type="button" @click="clearAllFilters">
          {{ t('pipeline.clearFilters') }}
        </button>
      </div>
    </div>

    <div class="stack">
      <div v-if="!companyListings.length && !loadError" class="card muted">{{ t('pipeline.empty') }}</div>

      <!-- Accordion per listing -->
      <div v-for="l in companyListings" :key="l.id" class="card">
        <button
          class="row justify-between items-center w-full"
          type="button"
          style="background: transparent; border: none; color: inherit; cursor: pointer; text-align: left; padding: 0"
          @click="toggleOpen(l.id)"
        >
          <div>
            <div class="font-semibold">{{ l.title }}</div>
            <div class="muted text-sm mt-4">{{ l.company }} · {{ l.location }} · {{ l.pay }}</div>
          </div>
          <div class="row items-center gap-8">
            <span class="kbd">{{ (filteredAppsByListing[l.id]?.length || 0) }} {{ t('pipeline.candidates') }}</span>
            <component :is="openListingId === l.id ? ChevronUp : ChevronDown" :size="18" />
          </div>
        </button>

        <div v-if="openListingId === l.id" class="stack mt-16">
          <div class="row justify-end gap-8 flex-wrap mb-8">
            <button class="btn btn-ghost btn-sm" type="button" @click="openImportModal(l.id)">
              <Upload :size="14" />
              {{ t('pipeline.import') }}
            </button>
            <button class="btn btn-ghost btn-sm" type="button" @click="exportListingZip(l.id)">
              <Download :size="14" />
              {{ t('pipeline.exportZip') }}
            </button>
          </div>

          <!-- Kanban columns -->
          <div class="kanban-grid">
            <div
              v-for="s in stages"
              :key="s"
              class="kanban-col"
              :style="{ borderTopColor: stageColor[s] }"
              :data-dnd="drag.appId && drag.listingId === l.id"
              :data-over="over.listingId === l.id && over.stage === s"
              @dragenter.prevent="onDragEnter(l.id, s)"
              @dragover.prevent
              @dragleave="onDragLeave(l.id, s)"
              @drop.prevent="onDrop(l.id, s)"
            >
              <div class="kanban-col-head">
                <span class="badge" :style="{ background: stageColor[s] + '22', color: stageColor[s], borderColor: stageColor[s] + '44' }">
                  {{ stageLabel[s] }}
                </span>
                <span class="kbd">{{ filteredAppsByStage(l.id)[s]?.length || 0 }}</span>
              </div>

              <div class="stack gap-8">
                <div
                  v-for="a in filteredAppsByStage(l.id)[s]"
                  :key="a.id"
                  class="kanban-card"
                  draggable="true"
                  :data-dragging="drag.appId === a.id"
                  @dragstart="onDragStart(l.id, a.id, s, $event)"
                  @dragend="onDragEnd"
                  @click="selectApplication(l.id, a); toggleCandidateModal(l.id, a)"
                >
                  <div class="kanban-card-actions">
                    <button
                      class="btn btn-ghost btn-sm btn-icon"
                      type="button"
                      :title="candidateModal.open && candidateModal.applicationId===a.id ? t('pipeline.close') : t('pipeline.open')"
                      @click.stop="toggleCandidateModal(l.id, a)"
                    >
                      <component :is="candidateModal.open && candidateModal.applicationId===a.id ? ChevronUp : ChevronDown" :size="14" />
                    </button>
                    <button
                      class="btn btn-ghost btn-sm btn-icon"
                      type="button"
                      :title="t('pipeline.delete')"
                      @click.stop="openDeleteConfirm(l.id, a)"
                      style="color: var(--color-danger)"
                    >
                      <Trash2 :size="14" />
                    </button>
                  </div>



                  <div class="row justify-between items-center">
                    <div>
                      <div class="font-semibold truncate">{{ candName(a) }}</div>
                      <div class="muted text-sm mt-4">{{ candMeta(a) }}</div>
                    </div>
                    <GripVertical :size="14" class="muted" style="opacity: 0.4" />
                  </div>

                  <div class="mt-8">
                    <button
                      v-if="!(notesUi.open && notesUi.appId === a.id)"
                      class="btn btn-ghost btn-sm w-full text-left"
                      type="button"
                      @click.stop="openNotes(a.id)"
                    >
                      <span class="muted">{{ t('pipeline.notes') }}:&nbsp;</span>
                      <span class="muted text-sm truncate">{{ notesPreview(a.notes) }}</span>
                    </button>
                    <textarea
                      v-else
                      class="textarea w-full"
                      rows="2"
                      :value="a.notes || ''"
                      placeholder="Notas..."
                      style="min-height: 50px; resize: vertical"
                      @click.stop
                      @input="(e) => setNotes(a.id, e.target.value)"
                      @blur="closeNotes"
                    />
                  </div>
                </div>

                <div v-if="!filteredAppsByStage(l.id)[s].length" class="card-sm muted text-sm text-center" style="padding: 16px">
                  <span v-if="drag.appId && drag.listingId === l.id">{{ t('pipeline.dropHere') }}</span>
                  <span v-else>(vacío)</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!isDesktop()" class="muted text-sm mt-16">* Datos de PocketBase (multi-sesión)</div>
        </div>
              </div>
            </div>
            </div>

    <!-- Candidate modal -->
    <ModalShell v-if="candidateModal.open" @close="closeCandidateModal">
      <template #title>
        Candidatura — {{ fullName(candidateModal.profile) || candidateModal.profile?.email || candidateModal.candidateUserId || '—' }}
      </template>

      <!-- Public application links need the web service; desktop imports internally instead. -->
      <div v-if="!isDesktop()" class="row justify-end items-center gap-8 mb-8">
        <code class="muted text-sm">
          <span v-if="candidateModal.loadingTokens">link: cargando…</span>
          <span v-else-if="latestApplyToken">link: {{ tokenStatus(latestApplyToken) }} · exp={{ fmtDate(latestApplyToken.expiresAt) || '—' }}</span>
          <span v-else>link: —</span>
        </code>
        <button class="btn btn-ghost btn-sm" type="button" @click="openApplyLinkModal(candidateModal.listingId, candidateModal.applicationId)" :disabled="!candidateModal.applicationId" title="Generar link (por candidatura)">🔗</button>
        <button v-if="applyLinkModal.url" class="btn btn-ghost btn-sm" type="button" @click="copyApplyUrl" title="Copiar link">Copiar</button>
      </div>

      <div class="row gap-8 flex-wrap mb-8">
        <button class="btn btn-sm" type="button" :class="candidateModal.tab==='datos' ? 'btn-secondary' : 'btn-ghost'" @click="candidateModal.tab='datos'">{{ t('pipeline.data') }}</button>
        <button class="btn btn-sm" type="button" :class="candidateModal.tab==='cv' ? 'btn-secondary' : 'btn-ghost'" @click="candidateModal.tab='cv'">{{ t('pipeline.cv') }}</button>
        <button class="btn btn-sm" type="button" :class="candidateModal.tab==='certs' ? 'btn-secondary' : 'btn-ghost'" @click="candidateModal.tab='certs'">{{ t('pipeline.certs') }}</button>
        <button class="btn btn-sm btn-primary" type="button" @click="openEmailModal({ candidateUserId: candidateModal.candidateUserId, listingId: candidateModal.listingId })" style="margin-left: auto">
          <Mail :size="14" />
          {{ t('candidate.sendEmail') }}
        </button>
      </div>

      <div class="stack gap-8">
        <div v-if="candidateModal.tab==='datos'" class="stack gap-8">
          <div class="card">
            <div class="font-bold">{{ t('pipeline.data') }}</div>
            <div class="muted text-sm mt-4">{{ candidateModal.profile?.firstName || '—' }} {{ candidateModal.profile?.lastName || '' }}</div>
            <div class="muted text-sm mt-4">{{ candidateModal.profile?.email || '—' }}</div>
            <div class="muted text-sm mt-4">{{ t('pipeline.fieldBirthDate') }}: {{ fmtDate(candidateModal.application?.birthDate) || '—' }}</div>
            <div class="muted text-sm mt-8">{{ t('pipeline.fieldCoverLetter') }}</div>
            <div style="white-space: pre-wrap">{{ candidateModal.application?.coverLetter || '—' }}</div>
          </div>
          <div class="row gap-8 flex-wrap">
            <button class="btn btn-ghost btn-sm" type="button" @click="exportZip" :disabled="!candidateModal.applicationId">{{ t('pipeline.exportCandidate') }}</button>
            <button class="btn btn-danger btn-sm" type="button" @click="hardDelete" :disabled="!candidateModal.applicationId">{{ t('pipeline.deleteIrreversible') }}</button>
          </div>
          <div v-if="candidateModal.outboxId" class="card">
            <div class="font-bold">{{ t('pipeline.itHireGenerated') }}</div>
            <code class="muted text-sm mt-4">outbox={{ candidateModal.outboxId }}</code>
            <div class="muted text-sm mt-4">{{ t('pipeline.viewOutbox') }}</div>
          </div>
          <div class="row gap-8 flex-wrap">
            <button class="btn btn-ghost btn-sm" type="button" @click="openHireModal">{{ t('pipeline.hireMark') }}</button>
          </div>
        </div>

        <div v-else-if="candidateModal.tab==='cv'" class="card">
          <div class="font-bold">{{ t('pipeline.cv') }}</div>
          <div v-if="candidateModal.loadingDocs" class="muted text-sm mt-4">{{ t('pipeline.loading') }}</div>
          <div v-else class="stack gap-8 mt-8">
            <div v-if="!cvDocs.length" class="muted text-sm">{{ t('pipeline.noCv') }}</div>
            <div v-for="d in cvDocs" :key="d.id" class="row justify-between items-center gap-8">
              <button class="btn btn-ghost btn-sm text-left" type="button" @click="candidateModal.selectedDocId=d.id">
                <code class="text-sm">{{ d.file }}</code>
              </button>
              <div class="row gap-8">
                <button class="btn btn-ghost btn-sm" type="button" @click="candidateModal.selectedDocId=d.id">Preview</button>
                <button class="btn btn-ghost btn-sm" type="button" @click="openDoc(d)">Abrir</button>
              </div>
            </div>
            <div v-if="selectedDoc && selectedDoc.docType==='cv'" class="card p-8" style="background: var(--color-bg)">
              <div class="muted text-sm mb-8">Preview: {{ selectedDoc.file }}</div>
              <div v-if="isDesktop()" class="stack gap-8">
                <div class="muted text-sm">La vista previa integrada no está disponible en desktop.</div>
                <button class="btn btn-ghost btn-sm" type="button" @click="openDoc(selectedDoc)">Abrir documento</button>
              </div>
              <iframe v-else :src="selectedDocUrl" class="docFrame" />
            </div>
          </div>
        </div>

        <div v-else class="card">
          <div class="font-bold">{{ t('pipeline.certs') }}</div>
          <div v-if="candidateModal.loadingDocs" class="muted text-sm mt-4">{{ t('pipeline.loading') }}</div>
          <div v-else class="stack gap-8 mt-8">
            <div v-if="!certDocs.length" class="muted text-sm">{{ t('pipeline.noCerts') }}</div>
            <div v-for="d in certDocs" :key="d.id" class="row justify-between items-center gap-8">
              <button class="btn btn-ghost btn-sm text-left" type="button" @click="candidateModal.selectedDocId=d.id">
                <code class="text-sm">{{ d.file }}</code>
              </button>
              <div class="row gap-8">
                <button class="btn btn-ghost btn-sm" type="button" @click="candidateModal.selectedDocId=d.id">Preview</button>
                <button class="btn btn-ghost btn-sm" type="button" @click="openDoc(d)">Abrir</button>
              </div>
            </div>
            <div v-if="selectedDoc && selectedDoc.docType==='certificate'" class="card p-8" style="background: var(--color-bg)">
              <div class="muted text-sm mb-8">Preview: {{ selectedDoc.file }}</div>
              <div v-if="isDesktop()" class="stack gap-8">
                <div class="muted text-sm">La vista previa integrada no está disponible en desktop.</div>
                <button class="btn btn-ghost btn-sm" type="button" @click="openDoc(selectedDoc)">Abrir documento</button>
              </div>
              <iframe v-else :src="selectedDocUrl" class="docFrame" />
            </div>
          </div>
        </div>

        <div v-if="candidateModal.error" class="card" style="border-color: color-mix(in oklab, var(--color-danger) 50%, var(--color-border))">
          <code class="text-sm">{{ candidateModal.error }}</code>
        </div>
      </div>
    </ModalShell>

    <!-- Delete confirm modal: after the candidate modal, which opens it, so it stacks on top. -->
    <ModalShell v-if="deleteConfirm.open" @close="closeDeleteConfirm">
      <template #title>{{ t('pipeline.deleteConfirm') }}</template>
      <div class="stack gap-8">
        <div class="card">
          <div class="font-bold">Confirmación</div>
          <p class="muted text-sm mt-4">
            Esto eliminará la candidatura y sus datos asociados (tokens y profile_imports). No se puede deshacer.
          </p>
        </div>
        <div class="row gap-8 flex-wrap">
          <button class="btn btn-ghost" type="button" @click="closeDeleteConfirm" :disabled="deleteConfirm.loading">{{ t('pipeline.cancel') }}</button>
          <button class="btn btn-danger" type="button" @click="confirmHardDelete" :disabled="deleteConfirm.loading">
            {{ deleteConfirm.loading ? t('pipeline.deleting') : t('pipeline.confirm') }}
          </button>
        </div>
        <div v-if="deleteConfirm.error" class="card" style="border-color: color-mix(in oklab, var(--color-danger) 50%, var(--color-border))">
          <code class="font-mono text-sm">{{ deleteConfirm.error }}</code>
        </div>
      </div>
    </ModalShell>

    <!-- Import modal -->
    <ModalShell v-if="importModal.open" @close="closeImportModal">
      <template #title>{{ t('pipeline.importTitle') }}</template>
      <div class="stack gap-8">
        <div class="card">
          <div class="font-bold">{{ t('pipeline.importPreviewTitle') }}</div>
          <p class="muted text-sm mt-4">
            {{ t('pipeline.importDesc') }}
          </p>
        </div>

        <div v-if="importModal.step==='edit'" class="stack gap-8">
          <div class="row gap-8 flex-wrap">
            <button class="btn btn-ghost btn-sm" type="button" @click="addImportRow" :disabled="importModal.rows.length>=10">
              <Plus :size="14" />
              {{ t('pipeline.addRow') }}
            </button>
            <label class="btn btn-ghost btn-sm cursor-pointer">
              <Upload :size="14" />
              {{ t('pipeline.uploadCvs') }}
              <input class="sr-only" type="file" multiple accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" @change="onPickImportCvs" />
            </label>
            <button class="btn btn-ghost btn-sm" type="button" @click="toImportPreview" :disabled="!importModal.rows.length">Preview</button>
          </div>

          <div v-if="importModal.rows.length" class="stack gap-8">
            <div v-for="(r,idx) in importModal.rows" :key="idx" class="card" style="background: var(--color-surface-hover)">
              <div class="row justify-between items-center gap-8">
                <code class="text-sm">#{{ idx+1 }}</code>
                <button class="btn btn-ghost btn-sm" type="button" @click="removeImportRow(idx)">Quitar</button>
              </div>
              <div class="grid-2 mt-8">
                <div class="stack gap-4">
                  <label class="muted text-sm font-semibold">{{ t('pipeline.fieldFirstName') }}</label>
                  <input class="input" v-model="r.firstName" maxlength="80" required />
                </div>
                <div class="stack gap-4">
                  <label class="muted text-sm font-semibold">{{ t('pipeline.fieldLastName') }}</label>
                  <input class="input" v-model="r.lastName" maxlength="120" required />
                </div>
                <div class="stack gap-4">
                  <label class="muted text-sm font-semibold">{{ t('pipeline.fieldEmail') }}</label>
                  <input class="input" type="email" v-model="r.email" maxlength="120" required />
                </div>
                <div class="stack gap-4">
                  <label class="muted text-sm font-semibold">{{ t('pipeline.fieldBirthDate') }}</label>
                  <input class="input" type="date" v-model="r.birthDate" required />
                </div>
              </div>
              <div class="stack gap-4 mt-8">
                <label class="muted text-sm font-semibold">{{ t('pipeline.fieldCoverLetter') }}</label>
                <textarea class="textarea" rows="3" v-model="r.coverLetter" maxlength="5000" required />
              </div>
              <div class="grid-2 mt-8">
                <div class="stack gap-4">
                  <label class="muted text-sm font-semibold">{{ t('pipeline.cvRequired') }}</label>
                  <input
                    class="input"
                    type="file"
                    :data-import="`cv-${idx}`"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    @change="(e)=>onPickImportCv(idx,e)"
                    required
                  />
                  <div class="row gap-8 flex-wrap mt-4">
                    <button class="btn btn-ghost btn-sm" type="button" @click="attachDemoPdfAsCv(idx)">{{ t('pipeline.useDemoCv') }}</button>
                    <button class="btn btn-ghost btn-sm" type="button" @click="attachDemoPdfAsCv(idx, 'Ana+Lopez+Martinez.pdf')">{{ t('pipeline.demoCvParseable') }}</button>
                  </div>
                  <div class="muted text-sm mt-4">{{ r.cv?.name || '—' }}</div>
                </div>
                <div class="stack gap-4">
                  <label class="muted text-sm font-semibold">{{ t('pipeline.certsOptional') }}</label>
                  <input
                    class="input"
                    type="file"
                    multiple
                    :data-import="`certs-${idx}`"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    @change="(e)=>onPickImportCerts(idx,e)"
                  />
                  <div class="row gap-8 flex-wrap mt-4">
                    <button class="btn btn-ghost btn-sm" type="button" @click="attachDemoPdfAsCert(idx)">{{ t('pipeline.addDemoCert') }}</button>
                  </div>
                  <div class="muted text-sm mt-4">{{ (r.certs||[]).length ? r.certs.map(f=>f.name).join(', ') : '—' }}</div>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="card muted">{{ t('pipeline.noEntries') }}</div>
        </div>

        <div v-else class="stack gap-8">
          <div class="card">
            <div class="font-bold">Preview</div>
            <div class="muted text-sm mt-4">{{ t('pipeline.previewSummary', { count: importModal.rows.length }) }}</div>
          </div>
          <div class="stack gap-8">
            <div v-for="(p,idx) in importPreview" :key="idx" class="card" style="background: var(--color-surface-hover)">
              <div class="font-bold">#{{ idx+1 }} — {{ p.firstName || '—' }} {{ p.lastName || '' }}</div>
              <div class="muted text-sm mt-4">{{ p.email || '—' }} · {{ t('pipeline.fieldBirthDate') }}: {{ p.birthDate || '—' }}</div>
              <div class="muted text-sm mt-4">CV: {{ p.cvName || '—' }} · {{ t('pipeline.certsOptional') }}: {{ p.certCount }}</div>
              <div v-if="p.error" class="text-sm mt-4" style="color: var(--color-danger)">{{ p.error }}</div>
            </div>
          </div>
          <div class="row gap-8 flex-wrap">
            <button class="btn btn-ghost" type="button" @click="importModal.step='edit'" :disabled="importModal.loading">{{ t('pipeline.back') }}</button>
            <button class="btn btn-primary" type="button" @click="runImport" :disabled="importModal.loading || importPreviewHasErrors || importAllDone">
              {{ importModal.loading ? t('pipeline.importing') : t('pipeline.importDefinitive') }}
            </button>
          </div>
          <div v-if="importModal.results.length" class="card" style="background: var(--color-bg)">
            <div class="muted text-sm">{{ t('pipeline.importResults') }}</div>
            <div v-for="(r, idx) in importModal.results" :key="idx" class="text-sm mt-8" :style="r.ok ? '' : 'color: var(--color-danger)'">
              {{ r.ok ? '✓' : '×' }} {{ r.name || r.inputEmail || '' }}
              <span class="muted">— {{ r.ok ? (r.res?.already ? 'ya estaba en la oferta; documentos añadidos a su candidatura' : 'importado') : r.error }}</span>
            </div>
          </div>
          <div v-if="importModal.error" class="card" style="border-color: color-mix(in oklab, var(--color-danger) 50%, var(--color-border))">
            <code class="text-sm">{{ importModal.error }}</code>
          </div>
        </div>
      </div>
    </ModalShell>

    <!-- Apply link modal -->
<ModalShell v-if="applyLinkModal.open" @close="closeApplyLinkModal">
  <template #title>{{ t('pipeline.applyLinkTitle') }}</template>
      <div class="stack gap-8">
        <div class="card">
          <div class="font-bold">{{ t('pipeline.applyLinkExpiry') }}</div>
          <div class="muted text-sm mt-4">{{ t('pipeline.applyLinkDesc') }}</div>
        </div>
        <div class="card stack gap-8">
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">{{ t('pipeline.expiryDate') }}</label>
            <input class="input" type="date" v-model="applyLinkModal.expiresDate" :min="minExpiryDate" :max="maxExpiryDate" required />
            <div class="muted text-sm mt-4">{{ t('pipeline.minExpiry') }}: {{ minExpiryDate }} · {{ t('pipeline.maxExpiry') }}: {{ maxExpiryDate }}</div>
          </div>
          <div v-if="expiryRangeError" class="text-sm" style="color: var(--color-danger)">{{ expiryRangeError }}</div>
          <div class="row gap-8 flex-wrap">
            <button class="btn btn-primary btn-sm" type="button" :disabled="applyLinkModal.loading || !!expiryRangeError" @click="generateApplyLink">
              {{ applyLinkModal.loading ? t('pipeline.generatingLink') : t('pipeline.generateLink') }}
            </button>
                    <button class="btn btn-ghost btn-sm" type="button" @click="closeApplyLinkModal">Cerrar</button>
          </div>
          <div v-if="applyLinkModal.url" class="card" style="background: var(--color-surface-hover)">
            <div class="muted text-sm">{{ t('pipeline.urlLabel') }}</div>
            <code class="text-sm mt-4" style="word-break: break-all">{{ applyLinkModal.url }}</code>
            <div class="row gap-8 mt-8">
              <button class="btn btn-ghost btn-sm" type="button" @click="copyApplyUrl">{{ t('pipeline.copy') }}</button>
              <button class="btn btn-ghost btn-sm" type="button" @click="openApplyUrl">Abrir</button>
            </div>
          </div>
          <div v-if="applyLinkModal.error" class="card" style="border-color: color-mix(in oklab, var(--color-danger) 50%, var(--color-border))">
            <code class="text-sm">{{ applyLinkModal.error }}</code>
          </div>
        </div>
      </div>
    </ModalShell>



    <!-- Hire modal -->
    <ModalShell v-if="hireModal.open" @close="closeHireModal">
      <template #title>Alta IT — Contratación</template>
      <div class="stack gap-8">
        <div class="card">
          <div class="font-bold">Datos de contratación</div>
          <div class="muted text-sm mt-4">
            Departments/JobTitles SOLO se usan aquí (Alta IT), no en el pipeline.
          </div>
        </div>
        <div class="card stack gap-8">
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Start date</label>
            <input class="input" type="date" v-model="hireModal.startDate" required />
          </div>
          <ComboBox label="Department" placeholder="Buscar department..." v-model="hireModal.department" :options="deptOptions" @search="loadDepartments" />
          <ComboBox label="Job Title" placeholder="Buscar job title..." v-model="hireModal.jobTitle" :options="jobTitleOptions" @search="loadJobTitles" />
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Cost center</label>
            <input class="input" v-model="hireModal.costCenter" placeholder="CC-123" required />
          </div>
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Manager email</label>
            <input class="input" type="email" v-model="hireModal.managerEmail" placeholder="manager@company.com" required />
          </div>
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Manager name (opcional)</label>
            <input class="input" v-model="hireModal.managerName" placeholder="Nombre Apellido" />
          </div>
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Access profile</label>
            <input class="input" v-model="hireModal.accessProfileId" placeholder="ACCESS-..." required />
          </div>
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Hardware profile (opcional)</label>
            <input class="input" v-model="hireModal.hardwareProfile" placeholder="Laptop / Mac / ..." />
          </div>
          <div class="stack gap-4">
            <label class="muted text-sm font-semibold">Notas IT (opcional)</label>
            <textarea class="textarea" rows="3" v-model="hireModal.notesIT" placeholder="Notas para IT..." />
          </div>
          <div class="muted text-sm">{{ deptLoading || jobTitleLoading ? 'Cargando catálogos…' : '' }}</div>
        </div>
        <div class="row gap-8 flex-wrap">
          <button class="btn btn-primary" type="button" :disabled="hireModal.loading" @click="confirmHire">{{ hireModal.loading ? 'Generando…' : 'Confirmar alta IT' }}</button>
          <button class="btn btn-ghost" type="button" :disabled="hireModal.loading" @click="closeHireModal">Cancelar</button>
        </div>
        <div v-if="hireModal.error" class="card" style="border-color: color-mix(in oklab, var(--color-danger) 50%, var(--color-border))">
          <code class="text-sm">{{ hireModal.error }}</code>
        </div>
      </div>
    </ModalShell>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, apiForm, desktopRequest, isDesktop } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { useAuthStore } from '../stores/auth.js'
import { useAppStore } from '../stores/app.js'
import { isPipelineListing } from '../lib/listingKinds.js'
import ModalShell from '../components/ModalShell.vue'
import ComboBox from '../components/ComboBox.vue'
import { ChevronDown, ChevronUp, Trash2, Upload, Download, Plus, X, GripVertical, Mail, Filter } from 'lucide-vue-next'

// ── Filtros avanzados ──
const filtersOpen = ref(false)
const documentActionError = ref('')

const filterStages = reactive(new Set())
const filterSkillsInput = ref('')
const filterSkills = ref('')
const filterLocationInput = ref('')
const filterLocation = ref('')
const filterSalaryMin = ref('')
const filterSalaryMax = ref('')
const filterDateFrom = ref('')
const filterDateTo = ref('')

let skillsTimer = null
let locationTimer = null
let salaryMinTimer = null
let salaryMaxTimer = null
let dateFromTimer = null
let dateToTimer = null

function onSkillsInput(e) {
  filterSkillsInput.value = e.target.value
  clearTimeout(skillsTimer)
  skillsTimer = setTimeout(() => { filterSkills.value = e.target.value }, 300)
}
function onLocationInput(e) {
  filterLocationInput.value = e.target.value
  clearTimeout(locationTimer)
  locationTimer = setTimeout(() => { filterLocation.value = e.target.value }, 300)
}
function onSalaryMinInput(e) {
  filterSalaryMin.value = e.target.value
  clearTimeout(salaryMinTimer)
  salaryMinTimer = setTimeout(() => {}, 300)
}
function onSalaryMaxInput(e) {
  filterSalaryMax.value = e.target.value
  clearTimeout(salaryMaxTimer)
  salaryMaxTimer = setTimeout(() => {}, 300)
}
function onDateFromInput(e) {
  filterDateFrom.value = e.target.value
  clearTimeout(dateFromTimer)
  dateFromTimer = setTimeout(() => {}, 300)
}
function onDateToInput(e) {
  filterDateTo.value = e.target.value
  clearTimeout(dateToTimer)
  dateToTimer = setTimeout(() => {}, 300)
}

function toggleStage(s) { filterStages.has(s) ? filterStages.delete(s) : filterStages.add(s) }

const activeFilterCount = computed(() => {
  let n = filterStages.size
  if (filterSkills.value.trim()) n++
  if (filterLocation.value.trim()) n++
  if (filterSalaryMin.value !== '') n++
  if (filterSalaryMax.value !== '') n++
  if (filterDateFrom.value !== '') n++
  if (filterDateTo.value !== '') n++
  return n
})

const activeFilterBadges = computed(() => {
  const b = []
  for (const s of filterStages) b.push({ key: `stage:${s}`, label: stageLabel[s] || s })
  if (filterSkills.value.trim()) b.push({ key: 'skills', label: `Skills: ${filterSkills.value.trim()}` })
  if (filterLocation.value.trim()) b.push({ key: 'location', label: `Ubicación: ${filterLocation.value.trim()}` })
  if (filterSalaryMin.value !== '') b.push({ key: 'salaryMin', label: `Salario mín: ${filterSalaryMin.value}` })
  if (filterSalaryMax.value !== '') b.push({ key: 'salaryMax', label: `Salario máx: ${filterSalaryMax.value}` })
  if (filterDateFrom.value !== '') b.push({ key: 'dateFrom', label: `Desde: ${filterDateFrom.value}` })
  if (filterDateTo.value !== '') b.push({ key: 'dateTo', label: `Hasta: ${filterDateTo.value}` })
  return b
})

function removeFilter(key) {
  if (key.startsWith('stage:')) filterStages.delete(key.slice(6))
  else if (key === 'skills') { filterSkillsInput.value = ''; filterSkills.value = '' }
  else if (key === 'location') { filterLocationInput.value = ''; filterLocation.value = '' }
  else if (key === 'salaryMin') filterSalaryMin.value = ''
  else if (key === 'salaryMax') filterSalaryMax.value = ''
  else if (key === 'dateFrom') filterDateFrom.value = ''
  else if (key === 'dateTo') filterDateTo.value = ''
}

function clearAllFilters() {
  filterStages.clear()
  filterSkillsInput.value = ''
  filterSkills.value = ''
  filterLocationInput.value = ''
  filterLocation.value = ''
  filterSalaryMin.value = ''
  filterSalaryMax.value = ''
  filterDateFrom.value = ''
  filterDateTo.value = ''
}

function applyFiltersToList(candidates) {
  let list = candidates
  if (filterStages.size) list = list.filter((a) => filterStages.has(a.stage))
  const skillsLower = filterSkills.value.trim().toLowerCase()
  if (skillsLower) {
    list = list.filter((a) => {
      const cid = a?.candidateUserId
      const p = cid ? profiles[cid] : null
      const tags = (Array.isArray(p?.tags) ? p.tags : []).map((t) => String(t).toLowerCase())
      return tags.some((t) => t.includes(skillsLower))
    })
  }
  const locLower = filterLocation.value.trim().toLowerCase()
  if (locLower) {
    list = list.filter((a) => {
      const cid = a?.candidateUserId
      const p = cid ? profiles[cid] : null
      return String(p?.location || '').toLowerCase().includes(locLower)
    })
  }
  const minPay = parseFloat(filterSalaryMin.value)
  const maxPay = parseFloat(filterSalaryMax.value)
  if (!isNaN(minPay) || !isNaN(maxPay)) {
    list = list.filter((a) => {
      const listing = listings.value.find((l) => l.id === openListingId.value)
      const payNum = parseFloat(String(listing?.pay || '').replace(/[^0-9.]/g, ''))
      if (isNaN(payNum)) return false
      if (!isNaN(minPay) && payNum < minPay) return false
      if (!isNaN(maxPay) && payNum > maxPay) return false
      return true
    })
  }
  if (filterDateFrom.value || filterDateTo.value) {
    list = list.filter((a) => {
      const d = new Date(a.createdAt)
      const t = d.getTime()
      if (filterDateFrom.value && t < new Date(filterDateFrom.value).getTime()) return false
      if (filterDateTo.value) {
        const to = new Date(filterDateTo.value + 'T23:59:59').getTime()
        if (t > to) return false
      }
      return true
    })
  }
  return list
}

const route = useRoute()
const auth = useAuthStore()

const stages = ['nuevo', 'revisar', 'entrevista', 'oferta', 'descartado', 'hired']

const stageLabel = { nuevo: t('pipeline.nuevo'), revisar: t('pipeline.revisar'), entrevista: t('pipeline.entrevista'), oferta: t('pipeline.oferta'), descartado: t('pipeline.descartado'), hired: t('pipeline.hired') }

const stageColor = {
  nuevo: '#6366f1',
  revisar: '#f59e0b',
  entrevista: '#3b82f6',
  oferta: '#10b981',
  descartado: '#ef4444',
  hired: '#71717a',
}

const listings = ref([])
const appsByListing = reactive({})
const profiles = reactive({})

const openListingId = ref('')

const selectedAppByListing = reactive({})

function selectApplication(listingId, appRow) {
  const lid = String(listingId || '')
  if (!lid || !appRow?.id) return
  selectedAppByListing[lid] = appRow
}

const totalCandidates = computed(() => {
  let count = 0
  for (const id of Object.keys(appsByListing)) {
    count += (appsByListing[id]?.length || 0)
  }
  return count
})

const filteredAppsByListing = computed(() => {
  const out = {}
  for (const [lid, list] of Object.entries(appsByListing)) {
    out[lid] = applyFiltersToList(list || [])
  }
  return out
})

const filteredTotalCandidates = computed(() => {
  let count = 0
  for (const list of Object.values(filteredAppsByListing.value)) count += (list?.length || 0)
  return count
})

function filteredAppsByStage(listingId) {
  const map = Object.fromEntries(stages.map((s) => [s, []]))
  const list = Array.isArray(filteredAppsByListing.value[listingId]) ? filteredAppsByListing.value[listingId] : []
  for (const a of list) map[a.stage]?.push(a)
  return map
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
  applyTokens: [],
  loadingTokens: false,
  error: '',
})

const applyLinkModal = reactive({
  open: false,
  listingId: '',
  applicationId: '',
  expiresDate: '',
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

async function openEmailModal(app) {
  const cid = app?.candidateUserId
  const p = cid ? profiles[cid] : null
  const listing = companyListings.value.find((l) => l.id === openListingId.value)
  const nombre = fullName(p) || p?.email || cid || 'Candidato/a'
  const puesto = listing?.title || ''
  const empresa = listing?.company || 'Pharmamar'

  const subject = encodeURIComponent(`Pharmamar - ${puesto}`)
  const body = encodeURIComponent(
    `Hola ${nombre},\n\n` +
    `Nos ponemos en contacto contigo en relación al puesto de ${puesto} en ${empresa}.\n\n` +
    `Quedamos a tu disposición para cualquier consulta.\n\n` +
    `¡Saludos!\nEquipo de ${empresa}`
  )
  const mailtoUrl = `mailto:${encodeURIComponent(p?.email || '')}?subject=${subject}&body=${body}`
  if (isDesktop()) {
    documentActionError.value = ''
    try { await desktopRequest('openMail', { url: mailtoUrl }) }
    catch (e) { documentActionError.value = String(e?.message || e) }
    return
  }
  window.open(mailtoUrl, '_blank')
}

const deptOptions = ref([])

const importModal = reactive({
  open: false,
  step: 'edit',
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
    let error = ''
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    for (const f of certs) {
      if (f && typeof f.size === 'number' && f.size > 50 * 1024 * 1024) error = error || 'Certificado supera 50MB'
      if (f && f.type && !allowed.includes(String(f.type))) error = error || 'Certificado: tipo no permitido'
    }

    if (!firstName) error = error || 'Falta el nombre'
    if (!lastName) error = error || 'Faltan los apellidos'
    if (!email) error = error || 'Falta el email'
    if (!birthDate) error = error || 'Falta la fecha de nacimiento'
    if (!coverLetter) error = error || 'Falta la carta de presentación'
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

const importPreviewHasErrors = computed(() => importPreview.value.some((p) => !!p.error))
// Imported rows are never sent again: a second click would attach another copy of the CV.
const importAllDone = computed(() => importModal.rows.length > 0 && importModal.rows.every((r) => r.imported))

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
      if (r.imported) continue
      const fd = new FormData()
      fd.set('firstName', String(r.firstName || '').trim())
      fd.set('lastName', String(r.lastName || '').trim())
      fd.set('email', String(r.email || '').trim())
      fd.set('birthDate', String(r.birthDate || '').trim())
      fd.set('coverLetter', String(r.coverLetter || '').trim())
      const cvName = safeCvFilename(r)
      fd.set('cv', r.cv, cvName)
      for (const f of r.certs || []) fd.append('certificates', f)
      const res = await apiForm(`/interno/listings/${encodeURIComponent(importModal.listingId)}/import_candidate`, fd)
      r.imported = true
      importModal.results.push({ ok: true, inputEmail: r.email, name: `${r.firstName} ${r.lastName}`.trim(), res })
      console.log('[import_candidate] ok', { inputEmail: r.email, res })
    }
    importModal.step = 'preview'
  } catch (e) {
    importModal.error = String(e?.message || e)
    importModal.results.push({ ok: false, error: importModal.error })
    console.log('[import_candidate] error', importModal.error)
  } finally {
    // Rows imported before a failure are already on the board.
    await loadApplications(importModal.listingId).catch(() => {})
    importModal.loading = false
  }
}

async function exportListingZip(listingId) {
  const url = `/api/interno/listings/${encodeURIComponent(String(listingId || ''))}/export.zip`
  if (isDesktop()) {
    documentActionError.value = ''
    try { await desktopRequest('documentAction', { path: url, action: 'save' }) }
    catch (e) { documentActionError.value = String(e?.message || e) }
    return
  }
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

// A failed read must not look like an empty store (or invite publishing): keep what was
// shown, say it may be stale, and clear the notice on the next successful read.
const loadError = ref('')

async function loadListings() {
  try {
    const res = await api('/listings')
    listings.value = res.items || []
    loadError.value = ''
  } catch (e) {
    loadError.value = String(e?.message || e)
  }
}

const companyListings = computed(() => (listings.value || []).filter(isPipelineListing))

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

// Each desktop read takes the shared store's exclusive file lock and parses the whole
// state; polling every 3 s from several workstations starves writers on SMB.
const autoRefresh = reactive({ timer: null, listingId: '', intervalMs: isDesktop() ? 15000 : 3000 })

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
    let res
    try {
      res = await api(`/company/listings/${encodeURIComponent(listingId)}/applications`)
    } catch (e) {
      loadError.value = String(e?.message || e)
      return
    }
    appsByListing[listingId] = res.items || []
    loadError.value = ''
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
  return `(${t('pipeline.pending')})`
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
  } catch (e) {
    // "(sin CV)" would claim the candidate has no documents.
    candidateModal.docs = []
    candidateModal.error = `${t('pipeline.docsLoadError')}: ${e?.message || e}`
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
  if (isDesktop()) return
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

async function openDoc(d) {
  if (!candidateModal.applicationId || !d?.id) return
  const url = `/api/interno/applications/${encodeURIComponent(candidateModal.applicationId)}/documents/${encodeURIComponent(d.id)}`
  if (isDesktop()) {
    try { await desktopRequest('documentAction', { path: url, action: 'open' }) }
    catch (e) { candidateModal.error = String(e?.message || e) }
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function exportZip() {
  if (!candidateModal.applicationId) return
  const url = `/api/interno/applications/${encodeURIComponent(candidateModal.applicationId)}/export.zip`
  if (isDesktop()) {
    try { await desktopRequest('documentAction', { path: url, action: 'save' }) }
    catch (e) { candidateModal.error = String(e?.message || e) }
    return
  }
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
  if (isDesktop()) {
    applyLinkModal.error = 'Los enlaces de solicitud pública no están disponibles en modo desktop local.'
    applyLinkModal.url = ''
    return
  }
  applyLinkModal.url = ''
  if (!applyLinkModal.applicationId) return (applyLinkModal.error = 'Falta applicationId')
  const rangeErr = expiryRangeError.value
  if (rangeErr) return (applyLinkModal.error = rangeErr)
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
    prompt('Copia la URL:', applyLinkModal.url)
  }
}

function openApplyUrl() {
  if (!applyLinkModal.url) return
  window.open(applyLinkModal.url, '_blank', 'noopener,noreferrer')
}

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
  const appId = drag.appId
  try {
    await api(`/company/applications/${encodeURIComponent(appId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage }),
    })
  } catch (e) {
    // A conflict or read-only store must not look like the card just snapped back.
    useAppStore().toast = { kind: 'err', text: `No se pudo mover la candidatura: ${e?.message || e}` }
  } finally {
    await loadApplications(listingId).catch(() => {})
    onDragEnd()
  }


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
  const txt = String(notes || '').trim()
  if (!txt) return `(${t('pipeline.noNotes')})`
  const one = txt.split(/\r?\n/)[0]
  return one.length > 60 ? one.slice(0, 60) + '…' : one
}

// One debounce per application: a shared timer dropped card A's note when card B was edited.
const notesTimers = new Map()
function setNotes(appId, val) {
  const listingId = openListingId.value
  if (!listingId) return
  const list = appsByListing[listingId] || []
  const row = list.find((x) => x.id === appId)
  if (row) row.notes = val
  clearTimeout(notesTimers.get(appId))
  notesTimers.set(appId, setTimeout(async () => {
    notesTimers.delete(appId)
    try {
      await api(`/company/applications/${encodeURIComponent(appId)}`, { method: 'PATCH', body: JSON.stringify({ notes: val }) })
    } catch (e) {
      useAppStore().toast = { kind: 'err', text: `No se pudieron guardar las notas: ${e?.message || e}` }
    }
  }, 400))
}

onMounted(async () => {
  await auth.bootstrap()
  await loadListings().catch(() => {})
})

onBeforeUnmount(() => {
  stopAutoRefresh()
})
</script>

<style>
.kanban-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.kanban-col {
  border: 1px solid var(--color-border);
  border-top: 3px solid var(--color-border);
  background: var(--color-surface-hover);
  border-radius: var(--radius-lg);
  padding: 12px;
  transition:
    border-color var(--transition-base),
    background var(--transition-base);
}

[data-dnd='true'].kanban-col {
  border-color: rgba(255, 255, 255, 0.16);
}

[data-over='true'].kanban-col {
  border-color: rgba(255, 255, 255, 0.2);
  background: color-mix(in oklab, var(--color-surface-hover) 70%, var(--color-bg));
}

.kanban-col-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.kanban-card {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-base);
  padding: 12px;
  cursor: grab;
  position: relative;
  transition:
    border-color var(--transition-base),
    opacity var(--transition-base),
    background var(--transition-base);
}

.kanban-card:active {
  cursor: grabbing;
}

.kanban-card:hover {
  border-color: rgba(255, 255, 255, 0.14);
}

[data-dragging='true'].kanban-card {
  opacity: 0.5;
  border-color: rgba(255, 255, 255, 0.16);
  background: color-mix(in oklab, var(--color-surface) 75%, var(--color-bg));
}

.kanban-card-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-base);
}

.kanban-card:hover .kanban-card-actions {
  opacity: 1;
}

.docFrame {
  width: 100%;
  height: 60vh;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-base);
  background: white;
}

@media (max-width: 1100px) {
  .kanban-grid {
    grid-template-columns: 1fr;
  }
}
</style>
