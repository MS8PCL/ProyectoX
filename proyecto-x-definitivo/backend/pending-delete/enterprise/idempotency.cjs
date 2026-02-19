const { pbAdminRequest } = require('./pbAdmin.cjs')

function isUniqueError(e) {
  const msg = String(e?.message || '')
  return msg.includes('unique') || msg.includes('constraint') || msg.includes('already exists')
}

async function createOrGetByUnique(env, { collection, uniqueField, uniqueValue, createBody }) {
  try {
    const created = await pbAdminRequest(env, `/api/collections/${collection}/records`, {
      method: 'POST',
      body: JSON.stringify(createBody),
    })
    return { created: true, record: created }
  } catch (e) {
    if (!isUniqueError(e)) throw e
    const filter = encodeURIComponent(`${uniqueField}="${String(uniqueValue).replace(/"/g, '\\"')}"`)
    const list = await pbAdminRequest(env, `/api/collections/${collection}/records?perPage=1&page=1&filter=${filter}`)
    const hit = (list?.items || [])[0]
    if (!hit) throw e
    return { created: false, record: hit }
  }
}

module.exports = { createOrGetByUnique }
