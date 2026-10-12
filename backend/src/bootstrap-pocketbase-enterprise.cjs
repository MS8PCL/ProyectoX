// Bootstrap PocketBase enterprise collections for HR→IT provisioning layer.
// Usage: node src/bootstrap-pocketbase-enterprise.cjs
// Requires: POCKETBASE_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '')
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`
}

async function req(url, init) {
  const res = await fetch(url, init)
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { res, text, json }
}

async function adminToken(baseUrl, email, password) {
  const payload = JSON.stringify({ identity: email, password })

  let r = await req(joinUrl(baseUrl, '/api/collections/_superusers/auth-with-password'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })

  if (r.res.status === 404) {
    r = await req(joinUrl(baseUrl, '/api/admins/auth-with-password'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
  }

  if (!r.res.ok) throw new Error(`Admin auth failed: ${r.res.status} ${r.text}`)
  return r.json.token
}

async function ensureCollection(baseUrl, token, schema) {
  const hdr = { Authorization: `Bearer ${token}` }

  const check = await req(joinUrl(baseUrl, `/api/collections/${schema.name}`), { headers: hdr })
  if (check.res.ok) return { ok: true, existed: true, id: check.json.id }
  if (check.res.status !== 404) throw new Error(`Unexpected status checking ${schema.name}: ${check.res.status} ${check.text}`)

  const created = await req(joinUrl(baseUrl, '/api/collections'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(schema),
  })

  if (!created.res.ok) throw new Error(`Create failed (${schema.name}): ${created.res.status} ${created.text}`)
  return { ok: true, existed: false, id: created.json.id }
}

async function patchUsersForCorpRole(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` }
  const col = await req(joinUrl(baseUrl, '/api/collections/users'), { headers: hdr })
  if (!col.res.ok) return false

  const fields = col.json.fields || []
  const has = fields.find((f) => f.name === 'corpRole')
  if (!has) {
    fields.push({
      type: 'select',
      name: 'corpRole',
      required: false,
      system: false,
      values: ['HR', 'IT', 'FINANCE', 'ADMIN'],
      options: { maxSelect: 1 },
    })
  }

  const patch = { ...col.json, fields }
  const updated = await req(joinUrl(baseUrl, `/api/collections/${col.json.id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(patch),
  })

  if (!updated.res.ok) throw new Error(`Patch users failed: ${updated.res.status} ${updated.text}`)
  return true
}

function authedReadRule() {
  return '@request.auth.id != ""'
}

function adminWriteRule() {
  // Prefer strict writes through backend using admin token.
  // Allow ADMIN user (if corpRole present) to write directly too.
  return '@request.auth.corpRole = "ADMIN"'
}

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'
  const email = process.env.PB_ADMIN_EMAIL
  const password = process.env.PB_ADMIN_PASSWORD
  if (!email || !password) throw new Error('Missing PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD')

  const token = await adminToken(baseUrl, email, password)
  await patchUsersForCorpRole(baseUrl, token)

  // --- Catalog ---
  await ensureCollection(baseUrl, token, {
    name: 'catalog_items',
    type: 'base',
    system: false,
    fields: [
      {
        type: 'select',
        name: 'type',
        required: true,
        system: false,
        values: ['department', 'job_title', 'cost_center', 'access_profile', 'hardware_profile'],
        options: { maxSelect: 1 },
      },
      { type: 'text', name: 'key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      {
        type: 'select',
        name: 'status',
        required: true,
        system: false,
        values: ['active', 'deprecated', 'inactive'],
        options: { maxSelect: 1 },
      },
      { type: 'relation', name: 'owner_user', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'json', name: 'tags', required: false, system: false, options: { maxSize: 0 } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_catalog_items_key_unique ON catalog_items (key)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'catalog_revisions',
    type: 'base',
    system: false,
    fields: [
      { type: 'relation', name: 'item', required: true, system: false, options: { collectionId: 'catalog_items', maxSelect: 1, cascadeDelete: true } },
      { type: 'number', name: 'version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 200, min: 3, pattern: '' } },
      { type: 'date', name: 'valid_from', required: true, system: false, options: { min: '', max: '' } },
      { type: 'date', name: 'valid_to', required: false, system: false, options: { min: '', max: '' } },
      { type: 'bool', name: 'is_published', required: true, system: false, options: {} },
      { type: 'json', name: 'data', required: true, system: false, options: { maxSize: 0 } },
      { type: 'text', name: 'change_reason', required: false, system: false, options: { max: 2000, min: 0, pattern: '' } },
      { type: 'relation', name: 'changed_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'date', name: 'changed_at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'hash', required: false, system: false, options: { max: 128, min: 0, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_catalog_revisions_unique_key ON catalog_revisions (unique_key)',
      'CREATE INDEX idx_catalog_revisions_item_version ON catalog_revisions (item, version)',
      'CREATE INDEX idx_catalog_revisions_item_published ON catalog_revisions (item, is_published)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  // --- RBAC ---
  await ensureCollection(baseUrl, token, {
    name: 'rbac_rules',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 2, pattern: '' } },
      { type: 'select', name: 'status', required: true, system: false, values: ['active', 'inactive'], options: { maxSelect: 1 } },
      { type: 'number', name: 'priority', required: true, system: false, options: { min: 0, max: null, noDecimal: true } },
      { type: 'json', name: 'condition', required: true, system: false, options: { maxSize: 0 } },
      {
        type: 'relation',
        name: 'result_access_profiles',
        required: true,
        system: false,
        options: { collectionId: 'catalog_items', maxSelect: 50, cascadeDelete: false },
      },
      { type: 'number', name: 'version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'date', name: 'published_at', required: false, system: false, options: { min: '', max: '' } },
      { type: 'relation', name: 'published_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
    ],
    indexes: [
      'CREATE INDEX idx_rbac_rules_status_priority ON rbac_rules (status, priority)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'access_profile_entitlements',
    type: 'base',
    system: false,
    fields: [
      { type: 'relation', name: 'access_profile', required: true, system: false, options: { collectionId: 'catalog_items', maxSelect: 1, cascadeDelete: true } },
      { type: 'select', name: 'entitlement_type', required: true, system: false, values: ['ad_group', 'app_role', 'license_sku', 'other'], options: { maxSelect: 1 } },
      { type: 'text', name: 'entitlement_key', required: true, system: false, options: { max: 400, min: 1, pattern: '' } },
      { type: 'text', name: 'description', required: false, system: false, options: { max: 1000, min: 0, pattern: '' } },
      { type: 'text', name: 'system', required: false, system: false, options: { max: 120, min: 0, pattern: '' } },
      { type: 'select', name: 'criticality', required: false, system: false, values: ['low', 'medium', 'high'], options: { maxSelect: 1 } },
      { type: 'date', name: 'valid_from', required: false, system: false, options: { min: '', max: '' } },
      { type: 'date', name: 'valid_to', required: false, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 600, min: 3, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_access_profile_entitlements_unique_key ON access_profile_entitlements (unique_key)',
      'CREATE INDEX idx_access_profile_entitlements_profile ON access_profile_entitlements (access_profile)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'permission_previews',
    type: 'base',
    system: false,
    fields: [
      { type: 'select', name: 'entity_type', required: true, system: false, values: ['hire'], options: { maxSelect: 1 } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 60, min: 1, pattern: '' } },
      { type: 'relation', name: 'workflow_instance', required: false, system: false, options: { collectionId: 'workflow_instances', maxSelect: 1, cascadeDelete: true } },
      { type: 'date', name: 'computed_at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'json', name: 'inputs_snapshot', required: true, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'matched_rules', required: true, system: false, options: { maxSize: 0 } },
      { type: 'relation', name: 'access_profiles', required: true, system: false, options: { collectionId: 'catalog_items', maxSelect: 50, cascadeDelete: false } },
      { type: 'json', name: 'entitlements', required: true, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'diff', required: false, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'pinned_catalog_versions', required: false, system: false, options: { maxSize: 0 } },
      { type: 'bool', name: 'approved', required: true, system: false, options: {} },
      { type: 'relation', name: 'approved_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'date', name: 'approved_at', required: false, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE INDEX idx_permission_previews_entity ON permission_previews (entity_type, entity_id)',
      'CREATE INDEX idx_permission_previews_computed ON permission_previews (computed_at)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  // --- Workflow ---
  await ensureCollection(baseUrl, token, {
    name: 'workflow_definitions',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'key', required: true, system: false, options: { max: 120, min: 2, pattern: '' } },
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 2, pattern: '' } },
      { type: 'number', name: 'version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'select', name: 'status', required: true, system: false, values: ['draft', 'published', 'archived'], options: { maxSelect: 1 } },
      { type: 'text', name: 'description', required: false, system: false, options: { max: 2000, min: 0, pattern: '' } },
      { type: 'date', name: 'published_at', required: false, system: false, options: { min: '', max: '' } },
      { type: 'relation', name: 'published_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_workflow_definitions_unique_key ON workflow_definitions (unique_key)',
      'CREATE INDEX idx_workflow_definitions_key_status ON workflow_definitions (key, status)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'workflow_states',
    type: 'base',
    system: false,
    fields: [
      { type: 'relation', name: 'workflow_definition', required: true, system: false, options: { collectionId: 'workflow_definitions', maxSelect: 1, cascadeDelete: true } },
      { type: 'text', name: 'state_key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 1, pattern: '' } },
      { type: 'select', name: 'kind', required: true, system: false, values: ['start', 'normal', 'terminal'], options: { maxSelect: 1 } },
      { type: 'json', name: 'ui_meta', required: false, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'requirements', required: false, system: false, options: { maxSize: 0 } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_workflow_states_unique_key ON workflow_states (unique_key)',
      'CREATE INDEX idx_workflow_states_def ON workflow_states (workflow_definition)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'workflow_transitions',
    type: 'base',
    system: false,
    fields: [
      { type: 'relation', name: 'workflow_definition', required: true, system: false, options: { collectionId: 'workflow_definitions', maxSelect: 1, cascadeDelete: true } },
      { type: 'text', name: 'from_state_key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'text', name: 'to_state_key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 1, pattern: '' } },
      { type: 'json', name: 'guards', required: false, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'conditions', required: false, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'actions', required: false, system: false, options: { maxSize: 0 } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 300, min: 3, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_workflow_transitions_unique_key ON workflow_transitions (unique_key)',
      'CREATE INDEX idx_workflow_transitions_def_from ON workflow_transitions (workflow_definition, from_state_key)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'workflow_instances',
    type: 'base',
    system: false,
    fields: [
      { type: 'select', name: 'entity_type', required: true, system: false, values: ['hire'], options: { maxSelect: 1 } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 60, min: 1, pattern: '' } },
      { type: 'text', name: 'workflow_key', required: true, system: false, options: { max: 120, min: 2, pattern: '' } },
      { type: 'number', name: 'workflow_version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'relation', name: 'workflow_definition', required: true, system: false, options: { collectionId: 'workflow_definitions', maxSelect: 1, cascadeDelete: false } },
      { type: 'text', name: 'current_state_key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'select', name: 'status', required: true, system: false, values: ['active', 'blocked', 'completed', 'cancelled'], options: { maxSelect: 1 } },
      { type: 'relation', name: 'created_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_workflow_instances_unique_key ON workflow_instances (unique_key)',
      'CREATE INDEX idx_workflow_instances_entity ON workflow_instances (entity_type, entity_id)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'workflow_event_log',
    type: 'base',
    system: false,
    fields: [
      { type: 'relation', name: 'workflow_instance', required: true, system: false, options: { collectionId: 'workflow_instances', maxSelect: 1, cascadeDelete: true } },
      {
        type: 'select',
        name: 'event_type',
        required: true,
        system: false,
        values: [
          'transition_requested',
          'transitioned',
          'validation_failed',
          'action_enqueued',
          'action_succeeded',
          'action_failed',
          'approval_requested',
          'approval_decided',
          'publish',
          'external_linked',
        ],
        options: { maxSelect: 1 },
      },
      { type: 'text', name: 'from_state_key', required: false, system: false, options: { max: 120, min: 0, pattern: '' } },
      { type: 'text', name: 'to_state_key', required: false, system: false, options: { max: 120, min: 0, pattern: '' } },
      { type: 'json', name: 'payload', required: false, system: false, options: { maxSize: 0 } },
      { type: 'select', name: 'actor_type', required: true, system: false, values: ['user', 'system'], options: { maxSelect: 1 } },
      { type: 'relation', name: 'actor_user', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'date', name: 'at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE INDEX idx_workflow_event_log_instance_at ON workflow_event_log (workflow_instance, at)',
      'CREATE INDEX idx_workflow_event_log_corr ON workflow_event_log (correlation_id)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: 'false',
    deleteRule: 'false',
    options: {},
  })

  // --- Approvals ---
  await ensureCollection(baseUrl, token, {
    name: 'approval_policies',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'key', required: true, system: false, options: { max: 120, min: 2, pattern: '' } },
      { type: 'number', name: 'version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'select', name: 'status', required: true, system: false, values: ['draft', 'published', 'archived'], options: { maxSelect: 1 } },
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 2, pattern: '' } },
      { type: 'json', name: 'scope_condition', required: true, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'steps', required: true, system: false, options: { maxSize: 0 } },
      { type: 'date', name: 'published_at', required: false, system: false, options: { min: '', max: '' } },
      { type: 'relation', name: 'published_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_approval_policies_unique_key ON approval_policies (unique_key)',
      'CREATE INDEX idx_approval_policies_key_status ON approval_policies (key, status)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'approval_instances',
    type: 'base',
    system: false,
    fields: [
      { type: 'select', name: 'entity_type', required: true, system: false, values: ['hire'], options: { maxSelect: 1 } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 60, min: 1, pattern: '' } },
      { type: 'text', name: 'policy_key', required: true, system: false, options: { max: 120, min: 2, pattern: '' } },
      { type: 'number', name: 'policy_version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'relation', name: 'policy', required: true, system: false, options: { collectionId: 'approval_policies', maxSelect: 1, cascadeDelete: false } },
      { type: 'select', name: 'status', required: true, system: false, values: ['pending', 'approved', 'rejected', 'cancelled'], options: { maxSelect: 1 } },
      { type: 'date', name: 'created_at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'relation', name: 'created_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_approval_instances_unique_key ON approval_instances (unique_key)',
      'CREATE INDEX idx_approval_instances_entity ON approval_instances (entity_type, entity_id)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'approval_step_instances',
    type: 'base',
    system: false,
    fields: [
      { type: 'relation', name: 'approval_instance', required: true, system: false, options: { collectionId: 'approval_instances', maxSelect: 1, cascadeDelete: true } },
      { type: 'text', name: 'step_key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'number', name: 'order', required: true, system: false, options: { min: 0, max: null, noDecimal: true } },
      { type: 'select', name: 'assignee_type', required: true, system: false, values: ['user', 'group', 'resolver'], options: { maxSelect: 1 } },
      { type: 'relation', name: 'assignee_user', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'text', name: 'assignee_group', required: false, system: false, options: { max: 120, min: 0, pattern: '' } },
      { type: 'select', name: 'status', required: true, system: false, values: ['pending', 'approved', 'rejected', 'skipped'], options: { maxSelect: 1 } },
      { type: 'relation', name: 'decision_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'date', name: 'decision_at', required: false, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'comment', required: false, system: false, options: { max: 2000, min: 0, pattern: '' } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_approval_step_instances_unique_key ON approval_step_instances (unique_key)',
      'CREATE INDEX idx_approval_step_instances_instance ON approval_step_instances (approval_instance)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  // --- Outbox + OTRS links ---
  await ensureCollection(baseUrl, token, {
    name: 'integration_outbox',
    type: 'base',
    system: false,
    fields: [
      { type: 'select', name: 'kind', required: true, system: false, values: ['otrs_create_ticket', 'otrs_sync_status', 'email_send', 'mock_connector'], options: { maxSelect: 1 } },
      { type: 'select', name: 'entity_type', required: true, system: false, values: ['hire'], options: { maxSelect: 1 } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 60, min: 1, pattern: '' } },
      { type: 'text', name: 'pinned_workflow_key', required: true, system: false, options: { max: 120, min: 2, pattern: '' } },
      { type: 'number', name: 'pinned_workflow_version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'text', name: 'idempotency_key', required: true, system: false, options: { max: 300, min: 6, pattern: '' } },
      { type: 'json', name: 'payload', required: true, system: false, options: { maxSize: 0 } },
      { type: 'select', name: 'status', required: true, system: false, values: ['pending', 'processing', 'succeeded', 'failed', 'dead', 'exported_manually'], options: { maxSelect: 1 } },
      { type: 'number', name: 'attempts', required: true, system: false, options: { min: 0, max: null, noDecimal: true } },
      { type: 'date', name: 'next_retry_at', required: false, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'last_error', required: false, system: false, options: { max: 4000, min: 0, pattern: '' } },
      { type: 'json', name: 'export_blob', required: false, system: false, options: { maxSize: 0 } },
      { type: 'date', name: 'created_at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_integration_outbox_idempotency_key ON integration_outbox (idempotency_key)',
      'CREATE INDEX idx_integration_outbox_status ON integration_outbox (status)',
      'CREATE INDEX idx_integration_outbox_entity ON integration_outbox (entity_type, entity_id)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'otrs_ticket_links',
    type: 'base',
    system: false,
    fields: [
      { type: 'select', name: 'entity_type', required: true, system: false, values: ['hire'], options: { maxSelect: 1 } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 60, min: 1, pattern: '' } },
      { type: 'text', name: 'ticket_number', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'url', name: 'ticket_url', required: false, system: false, options: { exceptDomains: null, onlyDomains: null } },
      { type: 'select', name: 'status', required: true, system: false, values: ['open', 'in_progress', 'closed', 'unknown'], options: { maxSelect: 1 } },
      { type: 'date', name: 'linked_at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'relation', name: 'linked_by', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'json', name: 'meta', required: false, system: false, options: { maxSize: 0 } },
      { type: 'text', name: 'unique_key', required: true, system: false, options: { max: 260, min: 3, pattern: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_otrs_ticket_links_unique_key ON otrs_ticket_links (unique_key)',
      'CREATE INDEX idx_otrs_ticket_links_entity ON otrs_ticket_links (entity_type, entity_id)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  // --- Audit ---
  await ensureCollection(baseUrl, token, {
    name: 'audit_log',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'entity_type', required: true, system: false, options: { max: 80, min: 1, pattern: '' } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 60, min: 1, pattern: '' } },
      { type: 'text', name: 'action', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'json', name: 'before', required: false, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'after', required: false, system: false, options: { maxSize: 0 } },
      { type: 'select', name: 'actor_type', required: true, system: false, values: ['user', 'system'], options: { maxSelect: 1 } },
      { type: 'relation', name: 'actor_user', required: false, system: false, options: { collectionId: 'users', maxSelect: 1, cascadeDelete: false } },
      { type: 'date', name: 'at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 80, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id)',
      'CREATE INDEX idx_audit_log_corr ON audit_log (correlation_id)',
      'CREATE INDEX idx_audit_log_at ON audit_log (at)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: 'false',
    deleteRule: 'false',
    options: {},
  })

  console.log('[bootstrap-enterprise] ok: ensured enterprise collections')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
