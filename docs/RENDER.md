# Render — деплой и эксплуатация TelegramBotRelay

Релей живёт на **Render** (не Railway — Railway-edge `69.46.46.x` режется ТСПУ из РФ, Timeweb-VM его не достаёт; Render `216.24.57.x` достижим). Проверено вживую 2026-07-09.

## Официальная документация
- Docs (гайды): https://render.com/docs
- **API reference:** https://api-docs.render.com/reference/introduction
- **MCP-сервер Render:** https://render.com/docs/mcp-server — официальный MCP, даёт LLM-агенту инструменты управления Render (сервисы, деплои, логи, env). Стоит подключить для автоматизации.
- Dashboard: https://dashboard.render.com

## Наш сервис (as-built)
| Параметр | Значение |
|---|---|
| Сервис | `telegram-bot-relay` |
| Service ID | `srv-d97tpketrd3s739o7kqg` |
| URL | **https://telegram-bot-relay.onrender.com** |
| Repo | `github.com/VSenichevPersonal/TelegramBotRelay` (public), branch `master`, auto-deploy |
| Runtime / plan / регион | node / free / frankfurt |
| Build / Start | `npm install --omit=dev` / `node src/index.js` |
| Healthcheck | `/health` |
| Owner (workspace) | `tea-d97tnngk1i2s73ept2f0` (Vassiliy's workspace) |
| ENV | `RELAY_SITES` (JSON, задан в дашборде — не в git) |
| SSH-ключ | `~/.ssh/render_relay` (pub добавлен в Render Account → SSH Keys) |

🔑 Креды (API-ключ Render, SSH, ID) — в `~/.config/credos/railway-relay.env` (chmod 600, вне репо).

## Render API (мы через него деплоим/рулим)
База `https://api.render.com/v1`, auth `Authorization: Bearer $RENDER_API_KEY`.
```bash
source ~/.config/credos/railway-relay.env
API=https://api.render.com/v1; H="Authorization: Bearer $RENDER_API_KEY"
curl -s -H "$H" "$API/owners"                                   # owner id
curl -s -H "$H" "$API/services?limit=20"                        # список
curl -s -H "$H" "$API/services/$RENDER_RELAY_SERVICE_ID"        # инфо
curl -s -X POST -H "$H" "$API/services/$RENDER_RELAY_SERVICE_ID/deploys"   # ручной redeploy
curl -s -H "$H" "$API/services/$RENDER_RELAY_SERVICE_ID/deploys?limit=1"   # статус деплоя
curl -s -H "$H" "$API/services/$RENDER_RELAY_SERVICE_ID/logs"              # логи
# обновить env (RELAY_SITES) + auto-redeploy:
curl -s -X PUT -H "$H" -H 'content-type: application/json' \
  "$API/services/$RENDER_RELAY_SERVICE_ID/env-vars" \
  -d '[{"key":"RELAY_SITES","value":"<json>"}]'
```
Создание сервиса — `POST /v1/services` (type=web_service, repo, serviceDetails{env:node, plan:free, region, envSpecificDetails{buildCommand,startCommand}, healthCheckPath}, envVars). Для приватного repo нужен GitHub-OAuth в Render — мы сделали repo public (секретов в git нет, они в env).

## SSH в сервис
Ключ `~/.ssh/render_relay` добавлен в Render. Shell в контейнер:
```bash
ssh -i ~/.ssh/render_relay srv-d97tpketrd3s739o7kqg@ssh.frankfurt.render.com   # хост из дашборда
```

## Авто-деплой (включён через GitHub Action)
Сервис создан по repo-URL (без GitHub App) → нативный webhook Render не срабатывает.
Авто-деплой сделан через **GitHub Action** `.github/workflows/render-deploy.yml`: на push в master
дёргает Render API (`POST /v1/services/{id}/deploys`). Секреты репо: `RENDER_API_KEY`, `RENDER_SERVICE_ID`.
Проверено: push → Action success → Render deploy live. `git push` = авто-деплой.
Альтернатива (нативно): подключить GitHub App в дашборде Render (OAuth) — тогда webhook напрямую.

## Free-тариф: cold-start
Free засыпает после 15 мин простоя → первый запрос ждёт ~30-60с, дальше быстро. Для лидов — редкая задержка на первое сообщение.
**Лечение (keep-warm):** пинг `/health` каждые ~10 мин (cron-job.org / UptimeRobot / внешний cron) — держит тёплым, задержка → 0. Либо платный ($7/мес) always-on.

## Почему Render, а не Railway/Vercel/CF (матрица с Timeweb-VM)
| Хост | С VM (HTTPS) |
|---|---|
| `*.onrender.com` (216.24.57.x) | ✅ |
| Cloudflare edge (104.16.x, custom domain) | ✅ |
| `*.up.railway.app` (69.46.46.x) | 🔴 ТСПУ |
| `*.vercel.app` app-edge | 🔴 |
| `*.workers.dev` | 🔴 (IPv6/blocked) |

*As-built 2026-07-09.*
