// Shared helpers for job titles normalization.

function normalizeJobTitleKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

module.exports = { normalizeJobTitleKey }
