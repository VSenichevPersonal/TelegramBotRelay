# TelegramBotRelay

Мультитенант-шлюз для **Telegram Bot API** — egress из RU-хостинга, где `api.telegram.org` режется DPI (ТСПУ/RKN). Релей живёт на **Railway (EU)**, где Telegram доступен, и проксирует запросы наших RU-сайтов в обе стороны.

```
RU-сайт (Timeweb, TG блокируется)
   │  HTTPS (*.up.railway.app — ТСПУ не режет)
   ▼
TelegramBotRelay (Railway, EU)
   │  ├─ ИСХОДЯЩЕЕ → api.telegram.org (sendMessage / любой метод)
   │  └─ ВХОДЯЩЕЕ  ← Telegram webhook → форвард на backendUrl сайта
   ▼
Telegram Bot API
```

## Зачем
- Telegram из РФ (Timeweb, YC — любой RU-IP) режется DPI на TLS → бот не может слать уведомления/лиды.
- Railway (EU) достаёт Telegram нативно. Один релей обслуживает **все** RU-сайты (117fstec и будущие).
- Логика бота остаётся на сайте (рядом с БД). Релей — тупой stateless-пайп.

## Мультитенантность
Все сайты в одном env `RELAY_SITES` (JSON). Каждый — свой `apiKey` (авторизация) + `botToken`.
```json
{
  "117fstec": {
    "apiKey": "k_live_...",
    "botToken": "123456:ABC...",
    "backendUrl": "https://117fstec.credos.ru/api/bot",
    "webhookSecret": "whs_..."
  },
  "othersite": { "apiKey": "...", "botToken": "...", "backendUrl": "...", "webhookSecret": "..." }
}
```
Добавить сайт = добавить запись в `RELAY_SITES` (в панели Railway) → redeploy. Токены ботов хранятся ТОЛЬКО на релее.

## API

Auth исходящих: `Authorization: Bearer <apiKey>`.

### `GET /health`
`{ ok, service, sites, ts }` — без авторизации.

### `POST /v1/telegram/send`  (удобный sendMessage)
```
Authorization: Bearer <apiKey>
{ "chatId": "12345", "text": "Новый лид!", "parse_mode": "HTML" }
```
→ ответ Telegram как есть (`{ ok, result }`).

### `POST /v1/telegram/method/:method`  (любой метод Bot API)
```
POST /v1/telegram/method/sendDocument
Authorization: Bearer <apiKey>
{ "chat_id": "12345", "document": "https://..." }
```
Прокидывает тело в `api.telegram.org/bot<token>/<method>`.

### `POST /v1/webhook/:siteId`  (входящие от Telegram)
Сюда указывает `setWebhook`. Валидирует `X-Telegram-Bot-Api-Secret-Token` (если задан `webhookSecret`), отвечает Telegram `200` сразу, форвардит апдейт на `backendUrl` сайта (заголовок `X-Relay-Site: <siteId>`).

## Интеграция сайта (пример 117fstec)
Заменить прямые вызовы `api.telegram.org` на релей:
```js
// было: fetch(`https://api.telegram.org/bot${token}/sendMessage`, ...)
await fetch(`${process.env.TELEGRAM_RELAY_URL}/v1/telegram/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TELEGRAM_RELAY_KEY}` },
  body: JSON.stringify({ chatId, text }),
})
```
Входящие: `setWebhook` бота → `https://<relay>/v1/webhook/117fstec` (с `secret_token`).


> ⚠️ **Деплоить на Render, НЕ на Railway.** Railway-edge (69.46.46.x) режется ТСПУ из РФ — RU-сервер не достаёт `*.up.railway.app`. Проверено: `*.onrender.com` достижим с Timeweb VM, Railway/Vercel — нет. См. render.yaml.

## Деплой на Render
1. Render → New → Blueprint (render.yaml) ИЛИ Web Service из repo (runtime node).
2. ENV: `RELAY_SITES` (JSON выше). `PORT` Railway задаёт сам.
3. Healthcheck `/health` (в railway.json).
4. Взять URL `*.onrender.com` → он и есть база релея.

## MCP (опционально)
Простой stdio-MCP (`mcp/server.js`, без зависимостей) — даёт LLM-агенту инструменты `telegram_send`, `telegram_method`, `relay_health`. См. [llms.txt](llms.txt).
```
claude mcp add tg-relay --env RELAY_URL=https://<relay> --env RELAY_API_KEY=<apiKey> -- node ./mcp/server.js
```

## Безопасность
- `apiKey`/`botToken`/`webhookSecret` — только в env Railway, не в git.
- Rate-limit per site (env `RATE_LIMIT_*`).
- Webhook валидирует Telegram secret-token.
- HTTPS-only (Railway).
- Ограничение: релей — SPOF доставки лидов → мониторить `/health` + алерт.

## Контекст
Часть переезда 117fstec Railway→Timeweb. Полный разбор: `117FSTEC/.AITEAM/reference/LEAD_TRANSPORT_RU.md`.
