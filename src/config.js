/**
 * Конфиг мультитенант-релея.
 * Источник — env RELAY_SITES (JSON): { "<siteId>": { apiKey, botToken, backendUrl?, webhookSecret? } }
 * Пример:
 *   RELAY_SITES={"117fstec":{"apiKey":"k_live_...","botToken":"123:ABC","backendUrl":"https://117fstec.credos.ru/api/bot","webhookSecret":"whs_..."}}
 */
export function loadSites() {
  const raw = process.env.RELAY_SITES
  if (!raw) {
    console.warn('[config] RELAY_SITES не задан — 0 сайтов')
    return { byId: {}, byKey: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error('[config] RELAY_SITES невалидный JSON:', e.message)
    return { byId: {}, byKey: {} }
  }
  const byId = {}
  const byKey = {}
  for (const [id, cfg] of Object.entries(parsed)) {
    if (!cfg?.apiKey || !cfg?.botToken) {
      console.error(`[config] сайт "${id}" пропущен: нужны apiKey и botToken`)
      continue
    }
    const site = { id, ...cfg }
    byId[id] = site
    byKey[cfg.apiKey] = site
  }
  console.log(`[config] загружено сайтов: ${Object.keys(byId).length} [${Object.keys(byId).join(', ')}]`)
  return { byId, byKey }
}
