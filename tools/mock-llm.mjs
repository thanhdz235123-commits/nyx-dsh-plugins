#!/usr/bin/env node
/**
 * Deterministic OpenAI-completions stand-in for harness verification.
 *
 * Records every request body it receives as one JSON line so a test can assert
 * exactly which messages the harness sent, then streams a canned reply.
 *
 *   node tools/mock-llm.mjs [port] [dumpFile]
 *
 * Env: MOCK_LLM_PORT, MOCK_LLM_DUMP, MOCK_LLM_REPLY
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? process.env.MOCK_LLM_PORT ?? 63299)
const dump = process.argv[3] ?? process.env.MOCK_LLM_DUMP ?? '/tmp/dsh-message-edit/mock-requests.jsonl'
const chunkDelayMs = Number(process.env.MOCK_LLM_DELAY_MS ?? 0)
writeFileSync(dump, '')

let counter = 0

function replyFor(body) {
  const explicit = process.env.MOCK_LLM_REPLY
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user')
  const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
  counter += 1
  return `REPLY#${counter} to "${text.slice(0, 80)}"`
}

function chunks(text) {
  const pieces = []
  for (let index = 0; index < text.length; index += 12) pieces.push(text.slice(index, index + 12))
  return pieces
}

const server = createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'mock-1', name: 'Mock' }] }))
    return
  }
  let raw = ''
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    let body = null
    try { body = JSON.parse(raw) } catch { body = { raw } }
    appendFileSync(dump, `${JSON.stringify({ at: Date.now(), url: request.url, body })}\n`)
    const text = replyFor(body)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const id = `chatcmpl-mock-${counter}`
    const pieces = chunks(text)
    const emit = (index) => {
      if (index >= pieces.length) {
        response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }] })}\n\n`)
      if (chunkDelayMs > 0) setTimeout(() => emit(index + 1), chunkDelayMs)
      else emit(index + 1)
    }
    if (chunkDelayMs > 0) setTimeout(() => emit(0), chunkDelayMs)
    else emit(0)
    return
    /* eslint-disable no-unreachable */
    for (const piece of chunks(text)) {
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`)
    }
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${port}/v1 (dump: ${dump})`)
})
