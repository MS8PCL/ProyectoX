const { pbAdminRequest } = require('./pbAdmin.cjs')

function nowIso() {
  return new Date().toISOString()
}

async function audit(env, { entityType, entityId, action, before, after, actorType, actorUserId, correlationId }) {
  const payload = {
    entity_type: entityType,
    entity_id: String(entityId),
    action: String(action),
    before: before ?? null,
    after: after ?? null,
    actor_type: actorType || 'system',
    actor_user: actorUserId || null,
    at: nowIso(),
    correlation_id: correlationId,
  }
  return await pbAdminRequest(env, '/api/collections/audit_log/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

async function wfEvent(env, { workflowInstanceId, eventType, fromStateKey, toStateKey, payload, actorType, actorUserId, correlationId, at }) {
  const body = {
    workflow_instance: workflowInstanceId,
    event_type: eventType,
    from_state_key: fromStateKey || '',
    to_state_key: toStateKey || '',
    payload: payload ?? null,
    actor_type: actorType || 'system',
    actor_user: actorUserId || null,
    at: at || nowIso(),
    correlation_id: correlationId,
  }
  return await pbAdminRequest(env, '/api/collections/workflow_event_log/records', { method: 'POST', body: JSON.stringify(body) })
}

module.exports = { audit, wfEvent }
