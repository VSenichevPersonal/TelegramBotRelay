#!/usr/bin/env node
/**
 * Простой MCP-сервер (stdio, JSON-RPC 2.0, newline-delimited) для TelegramBotRelay.
 * Без внешних зависимостей. Даёт LLM-агенту инструменты слать Telegram через релей.
 *
 * ENV:
 *   RELAY_URL     — база релея, напр. https://telegrambotrelay-production.up.railway.app
 *   RELAY_API_KEY — apiKey сайта (из RELAY_SITES)
 *
 * Запуск: RELAY_URL=... RELAY_API_KEY=... node mcp/server.js
 * Подключение в Claude Code: claude mcp add tg-relay -- node /path/mcp/server.js  (+ env)
 */
import readline from 'node:readline'

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/$/, '')
const API_KEY = process.env.RELAY_API_KEY || ''

const TOOLS = [
  {
    name: 'telegram_send',
    description: 'Отправить текстовое сообщение в Telegram-чат через релей (sendMessage).',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'ID чата или @username' },
        text: { type: 'string', description: 'Текст сообщения' },
        parse_mode: { type: 'string', enum: ['MarkdownV2', 'HTML', 'Markdown'], description: 'Опц. форматирование' },
      },
      required: ['chatId', 'text'],
    },
  },
  {
    name: 'telegram_method',
    description: 'Вызвать произвольный метод Telegram Bot API через релей (sendPhoto, sendDocument, getMe, ...).',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Имя метода Bot API' },
        params: { type: 'object', description: 'Тело запроса метода' },
      },
      required: ['method'],
    },
  },
  {
    name: 'relay_health',
    description: 'Проверить доступность релея (GET /health).',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function callRelay(path, body, method = 'POST') {
  const r = await fetch(`${RELAY_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, body: j }
}

async function runTool(name, args) {
  if (!RELAY_URL) throw new Error('RELAY_URL не задан')
  if (name === 'relay_health') return await callRelay('/health', null, 'GET')
  if (name === 'telegram_send') return await callRelay('/v1/telegram/send', args)
  if (name === 'telegram_method')
    return await callRelay(`/v1/telegram/method/${args.method}`, args.params || {})
  throw new Error(`unknown tool: ${name}`)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'telegram-bot-relay', version: '1.0.0' },
        },
      })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const out = await runTool(params.name, params.arguments || {})
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] },
      })
    } else if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      // уведомления без ответа
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } })
  }
})

process.stderr.write('[mcp] telegram-bot-relay MCP на stdio\n')
