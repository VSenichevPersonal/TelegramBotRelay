# TelegramBotRelay

Мультитенант-шлюз для **Telegram Bot API** — egress из RU-хостинга, где `api.telegram.org` режется DPI (ТСПУ/RKN). Релей живёт на **Render (Frankfurt)**, где Telegram доступен, и проксирует запросы наших RU-сайтов.

```
RU-сайт (Timeweb, TG блокируется)
   │  HTTPS (*.onrender.com — ТСПУ не режет)
   ▼
TelegramBotRelay (Render, Frankfurt)
   │  ├─ ИСХОДЯЩЕЕ → api.telegram.org (sendMessage / любой метод)
   │  └─ ВХОДЯЩЕЕ  ← Telegram webhook → форвард на backendUrl сайта
   ▼
Telegram Bot API
```

> ⚠️ **Деплоить на Render, НЕ на Railway.** Railway-edge (69.46.46.x) режется ТСПУ из РФ — RU-сервер не достаёт `*.up.railway.app`. Проверено: с Timeweb VM `*.onrender.com` (216.24.57.x) достижим по HTTPS, а `*.up.railway.app` и `*.vercel.app` — нет.

## Зачем
- Telegram из РФ (Timeweb, YC — любой RU-IP) режется DPI на TLS → бот не может слать уведомления/лиды.
- Render (EU) достаёт Telegram нативно. Один релей обслуживает **все** RU-сайты (117fstec и будущие).
- Логика бота остаётся на сайте (рядом с БД). Релей — тупой stateless-пайп.

## Боевой сервис

| | |
|---|---|
| URL | `https://telegram-bot-relay.onrender.com` |
| Service ID | `srv-d97tpketrd3s739o7kqg` |
| Дашборд | https://dashboard.render.com/web/srv-d97tpketrd3s739o7kqg |
| Регион | Frankfurt |
| План | `free` |
| Деплой | autoDeploy с ветки `master` (по коммиту) |
| Репозиторий | https://github.com/VSenichevPersonal/TelegramBotRelay |
| SSH | `srv-d97tpketrd3s739o7kqg@ssh.frankfurt.render.com` |

Проверено на живом сервисе: `/health` → 200; `getMe` через релей → `ok:true` (бот `@fstek117_bot`), ~0.5 с.

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
Добавить сайт = добавить запись в `RELAY_SITES` (в дашборде Render) → redeploy. Токены ботов хранятся ТОЛЬКО на релее.

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

## Текущая схема трафика (важно)

Релей нужен только для **исходящего** направления. Входящие вебхуки Telegram доставляет на RU-сервер напрямую — DPI режет исходящий TLS с SNI `api.telegram.org`, а входящее соединение Telegram→`117fstec.credos.ru` не трогает.

Поэтому в бою сейчас:
- **исходящее** (бот шлёт лид/ответ) → через релей;
- **входящее** (апдейты от Telegram) → напрямую на `https://117fstec.credos.ru/api/bot`.

Проверить: `POST /v1/telegram/method/getWebhookInfo`.

Переводить входящие на релей (`/v1/webhook/117fstec`) стоит, только если Telegram перестанет достучаться до RU-сервера напрямую, либо чтобы спрятать origin. Тогда:
```
setWebhook(url="https://telegram-bot-relay.onrender.com/v1/webhook/117fstec",
           secret_token=<webhookSecret сайта>)
```
Это правка боевого бота — делать осознанно, откат тем же `setWebhook` на старый URL.

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

## Деплой на Render
1. Render → New → Blueprint (`render.yaml`) ИЛИ Web Service из repo (runtime `node`).
2. ENV: `RELAY_SITES` (JSON выше) — задать в дашборде, `sync: false` в блюпринте. `PORT` Render задаёт сам.
3. Healthcheck `/health` (в `render.yaml`).
4. Взять URL `*.onrender.com` → он и есть база релея.

Деплой автоматический: push в `master` → сборка → рестарт.

## Эксплуатация

**Free-план засыпает.** Render усыпляет free web service после ~15 минут без запросов; холодный старт — десятки секунд. Первый лид после простоя приедет с заметной задержкой (Telegram-ретраи это переживут, но пользователь ждёт). Варианты:
- перевести сервис на платный план (нет засыпания) — предпочтительно для боевой доставки лидов;
- либо пинговать `/health` внешним крон-мониторингом чаще, чем раз в 15 минут.

**Мониторинг.** Релей — SPOF доставки лидов. Держать внешний аптайм-чек на `GET /health` с алертом.

**Диагностика.**
```bash
# живой health
curl -s https://telegram-bot-relay.onrender.com/health

# egress до Telegram (read-only, ничего не шлёт)
curl -s -X POST https://telegram-bot-relay.onrender.com/v1/telegram/method/getMe \
  -H "authorization: Bearer $RELAY_API_KEY" -H 'content-type: application/json' -d '{}'

# состояние вебхука
curl -s -X POST https://telegram-bot-relay.onrender.com/v1/telegram/method/getWebhookInfo \
  -H "authorization: Bearer $RELAY_API_KEY" -H 'content-type: application/json' -d '{}'
```

Коды: `401 unauthorized` · `429 rate_limited` · `400 bad_request` · `404 unknown_site/not_found` · `502 telegram_unreachable`.

## MCP (опционально)
Простой stdio-MCP (`mcp/server.js`, без зависимостей) — даёт LLM-агенту инструменты `telegram_send`, `telegram_method`, `relay_health`. См. [llms.txt](llms.txt).
```
claude mcp add tg-relay --env RELAY_URL=https://telegram-bot-relay.onrender.com --env RELAY_API_KEY=<apiKey> -- node ./mcp/server.js
```

## Безопасность
- `apiKey`/`botToken`/`webhookSecret` — только в env Render, не в git.
- **Render API-ключ** (`rnd_...`) даёт полный доступ к аккаунту, включая чтение env со всеми botToken. Не коммитить, не вставлять в чаты/тикеты. При утечке — отозвать в Render → Account Settings → API Keys и выпустить новый.
- Rate-limit per site (env `RATE_LIMIT_*`).
- Webhook валидирует Telegram secret-token.
- HTTPS-only (Render).
- Ограничение: релей — SPOF доставки лидов → мониторить `/health` + алерт.

## Контекст
Часть переезда 117fstec Railway→Timeweb. Полный разбор: `117FSTEC/.AITEAM/reference/LEAD_TRANSPORT_RU.md`.
