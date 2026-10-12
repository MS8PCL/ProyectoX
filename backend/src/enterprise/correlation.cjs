function correlationFromReq(req) {
  const h = req?.headers
  const raw = h?.get ? h.get('x-correlation-id') : null
  const v = String(raw || '').trim()
  if (v && v.length <= 80) return v
  return `corr_${crypto.randomUUID()}`
}

function attachCorrelation(app) {
  app.use('*', async (c, next) => {
    const corr = correlationFromReq(c.req.raw)
    c.set('correlationId', corr)
    c.header('x-correlation-id', corr)
    await next()
  })
}

module.exports = { correlationFromReq, attachCorrelation }
