/**
 * TelegramBotRelay — мультитенант-шлюз Telegram Bot API.
 *
 * Зачем: RU-хостинг (Timeweb/YC) режет api.telegram.org DPI-ом (исходящее).
 * Релей живёт на Render (Frankfurt), где Telegram доступен, и проксирует:
 *   - ИСХОДЯЩЕЕ: сайт → релей → api.telegram.org (sendMessage и любой метод Bot API)
 *   - ВХОДЯЩЕЕ:  Telegram → релей (webhook) → backendUrl сайта
 *
 * Мультитенант: несколько сайтов/ботов, каждый со своим apiKey + botToken.
 * Полный протокол и примеры — см. README.md и llms.txt.
 */
import express from 'express'
import { loadSites } from './config.js'

const PORT = process.env.PORT || 3000
const TG_API = process.env.TG_API_ROOT || 'https://api.telegram.org'
const REQ_TIMEOUT = Number(process.env.REQ_TIMEOUT_MS || 15000)
const RL_MAX = Number(process.env.RATE_LIMIT_MAX || 30)
const RL_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS || 10000)

const { byId: SITES, byKey: SITES_BY_KEY } = loadSites()

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '512kb' }))

// ---- rate limit (in-memory, per site) ----
const hits = new Map()
function rateLimit(id) {
  const now = Date.now()
  const arr = (hits.get(id) || []).filter((t) => now - t < RL_WINDOW)
  arr.push(now)
  hits.set(id, arr)
  return arr.length <= RL_MAX
}

// ---- auth: Bearer <apiKey> ----
function auth(req, res, next) {
  const h = req.get('authorization') || ''
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  const site = SITES_BY_KEY[key]
  if (!site) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!rateLimit(site.id)) return res.status(429).json({ ok: false, error: 'rate_limited' })
  req.site = site
  next()
}

// ---- вызов Bot API с таймаутом и ретраем ----
async function tgCall(botToken, method, body, tries = 2) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT)
    try {
      const r = await fetch(`${TG_API}/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      const j = await r.json().catch(() => ({}))
      return { status: r.status, body: j }
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
    }
  }
  throw lastErr
}

// ---- health ----
app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'telegram-bot-relay', sites: Object.keys(SITES).length, ts: new Date().toISOString() }),
)

// ---- ИСХОДЯЩЕЕ: удобный sendMessage ----
app.post('/v1/telegram/send', auth, async (req, res) => {
  const { chatId, text, parse_mode, disable_web_page_preview, reply_markup, disable_notification } = req.body || {}
  if (!chatId || !text) return res.status(400).json({ ok: false, error: 'chatId_and_text_required' })
  try {
    const r = await tgCall(req.site.botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode,
      disable_web_page_preview,
      disable_notification,
      reply_markup,
    })
    res.status(r.status).json(r.body)
  } catch (e) {
    console.error(`[send] ${req.site.id}: ${e.message}`)
    res.status(502).json({ ok: false, error: 'telegram_unreachable', detail: e.message })
  }
})

// ---- ИСХОДЯЩЕЕ: любой метод Bot API (passthrough) ----
app.post('/v1/telegram/method/:method', auth, async (req, res) => {
  const { method } = req.params
  if (!/^[a-zA-Z]+$/.test(method)) return res.status(400).json({ ok: false, error: 'bad_method' })
  try {
    const r = await tgCall(req.site.botToken, method, req.body || {})
    res.status(r.status).json(r.body)
  } catch (e) {
    console.error(`[method:${method}] ${req.site.id}: ${e.message}`)
    res.status(502).json({ ok: false, error: 'telegram_unreachable', detail: e.message })
  }
})

// ---- ИСХОДЯЩЕЕ: прозрачный Bot API passthrough ----
// Формат Telegram: /bot<token>/<method>. Позволяет сайту просто сменить apiRoot
// (grammy client.apiRoot / базу raw-fetch) на URL релея — код почти не меняется.
// Авторизация — по самому botToken (должен принадлежать сконфигурированному сайту).
app.all('/bot:token/:method', async (req, res) => {
  const { token, method } = req.params
  const site = Object.values(SITES).find((s) => s.botToken === token)
  if (!site) return res.status(401).json({ ok: false, error: 'unknown_bot_token' })
  if (!/^[a-zA-Z_]+$/.test(method)) return res.status(400).json({ ok: false, error: 'bad_method' })
  if (!rateLimit(site.id)) return res.status(429).json({ ok: false, error: 'rate_limited' })
  try {
    const r = await tgCall(token, method, req.body || {})
    res.status(r.status).json(r.body)
  } catch (e) {
    console.error(`[passthrough:${method}] ${site.id}: ${e.message}`)
    res.status(502).json({ ok: false, error: 'telegram_unreachable', detail: e.message })
  }
})

// ---- ВХОДЯЩЕЕ: webhook fan-in → форвард на backend сайта ----
app.post('/v1/webhook/:siteId', async (req, res) => {
  const site = SITES[req.params.siteId]
  if (!site) return res.status(404).json({ ok: false, error: 'unknown_site' })
  // Валидация секрет-токена Telegram (setWebhook secret_token)
  if (site.webhookSecret) {
    const got = req.get('x-telegram-bot-api-secret-token')
    if (got !== site.webhookSecret) return res.status(403).json({ ok: false, error: 'bad_secret' })
  }
  if (!site.backendUrl) return res.status(200).json({ ok: true, note: 'no_backend_configured' })
  // Отвечаем Telegram сразу, форвардим асинхронно (иначе ретраи Telegram)
  res.status(200).json({ ok: true })
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT)
    await fetch(site.backendUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-site': site.id,
        // проброс секрета Telegram → backend валидирует его как свой TELEGRAM_WEBHOOK_SECRET
        ...(site.webhookSecret ? { 'x-telegram-bot-api-secret-token': site.webhookSecret } : {}),
      },
      body: JSON.stringify(req.body || {}),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
  } catch (e) {
    console.error(`[webhook] ${site.id} форвард на backend упал: ${e.message}`)
  }
})

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }))

app.listen(PORT, () => console.log(`[relay] TelegramBotRelay на :${PORT}, сайтов: ${Object.keys(SITES).length}`))
