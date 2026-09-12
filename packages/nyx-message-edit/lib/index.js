/**
 * nyx-message-edit — host half.
 *
 * Real edit-message for DeepSeek Harness, built out of the Session's own
 * surface mechanism instead of a side conversation store:
 *
 *   edit  ==  surfaceOp {op:'replace', start:<edited node>, end:<surface tail>}
 *             + one regenerated turn on the SAME session
 *
 * The replacement node is a `user/message` carrying the new text. The surface
 * becomes `[everything before the edited message] + [edited message]`, the
 * append-only log keeps the whole history for audit, and `deriveMessages()`
 * — which is what the agent loop feeds the provider — now returns exactly the
 * truncated conversation. The regenerated turn is opened with
 * `wakeDriver()` and its first step appends no message at all, so the edited
 * message is never duplicated at the tail.
 *
 * Nothing here re-implements conversation state: the log, the surface fold,
 * the request build, streaming, the model selector and the system prompt are
 * all the harness's own.
 *
 * @module nyx-message-edit
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'nyx-message-edit'
/** Bumped per host revision; the health route reports it. */
export const BUILD = '0.1.0'
export const inject = ['connection', 'agents']

const ROUTE_STATE = '/api/nyx-message-edit.state'
const ROUTE_EDIT = '/api/nyx-message-edit.edit'
const ROUTE_HEALTH = '/api/nyx-message-edit.health'
const ROUTE_DIAG = '/api/nyx-message-edit.diag'

/** Source marker written into every replacement message this plugin owns. */
const EDIT_MARKER = 'nyx-message-edit'

/**
 * Per-session edit that has been requested but not yet committed to the log.
 * Keyed by session id; consumed exactly once by the `agent/pre-step` hook of
 * the regenerating turn.
 * @type {Map<string, {resolve: Function, reject: Function, messageId: string, text: string, rpcId: string, timer: any, committed?: object}>}
 */
const pendingEdits = new Map()

/**
 * Append one line to `<DSH_HOME>/nyx-message-edit-diag.jsonl`.
 *
 * A failed edit is otherwise invisible from the outside: the reader sees a
 * button do nothing and there is no trace to read. Every attempt and every
 * refusal lands here with its reason, so the next report is a fact.
 */
async function diag(ctx, record) {
  try {
    const home = ctx.get('homePaths')?.dshHome ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
    const file = path.join(home, 'nyx-message-edit-diag.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify({ at: Date.now(), ...record })}\n`)
  } catch {
    /* diagnostics never break the edit */
  }
}

/**
 * Last committed edit per session, for the client's state route.
 * @type {Map<string, Array<object>>}
 */
const editHistory = new Map()

/** @param {string} code @param {string} message @param {number} [status] */
function fail(code, message, status = 400) {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

/** @param {unknown} value */
function ok(value) {
  return Response.json({ ok: true, value })
}

/** @param {string} code @param {string} message */
function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// surface model
// ---------------------------------------------------------------------------

/** Model-visible surface nodes of one session, in order, as absolute seqs. */
function surfaceNodes(session) {
  const nodes = session.surface?.nodes
  return Array.isArray(nodes) ? nodes : []
}

/**
 * Find the current surface node holding one user message.
 * @param session - live Session.
 * @param messageId - the message's durable identity.
 * @returns index, seq and event, or undefined when the message is no longer
 *   on the model-visible surface (already edited away, compacted, etc.).
 */
function locateSurfaceMessage(session, messageId) {
  const nodes = surfaceNodes(session)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event === undefined) continue
    if (event.type !== 'user/message') continue
    if (event.data?.id !== messageId) continue
    return { index, seq: event.seq, event }
  }
  return undefined
}

/** Plain text of one message's text blocks, joined. */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Rebuild the edited message: every non-text block keeps its position, the
 * first text block is replaced by the new text, extra text blocks drop.
 */
function rebuildContent(content, text) {
  const blocks = []
  let placed = false
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text') {
      if (placed) continue
      placed = true
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    blocks.push(block)
  }
  if (!placed && text !== '') blocks.push({ type: 'text', text })
  return blocks
}

/** Save-point coordinates of one event: the turn and step it belongs to. */
function turnStepOf(session, seq) {
  for (let cursor = seq; cursor >= 0; cursor -= 1) {
    const event = session.eventAt(cursor)
    if (event === undefined) break
    if (event.type === 'turn/start') return { turn: event.data?.turn, step: undefined }
    if (event.type === 'step/start') return { turn: event.data?.turn, step: event.data?.step }
  }
  return { turn: undefined, step: undefined }
}

/**
 * Every flow key the Chat transcript renders for one surface event, so the
 * client can hide the rows the edit removed. Mirrors the harness's own
 * `conversationContextKey(kind, id)` = `${kind.length}:${kind}${id}` and the
 * definition ids from `dsh-client-ui-chat`.
 */
/** `conversationContextKey(kind, id)` exactly as the client composes it. */
function chatKey(kind, id) {
  return `${kind.length}:${kind}${id}`
}

function chatKeysOf(session, event) {
  const keys = []
  if (event.type === 'user/message') {
    const id = event.data?.id ?? ''
    keys.push(chatKey('input-message', id))
    keys.push(chatKey('steering', id))
  } else if (event.type === 'assistant/message') {
    const turn = event.data?.turn
    const step = event.data?.step
    if (Number.isSafeInteger(turn) && Number.isSafeInteger(step)) keys.push(chatKey('assistant-step', `${turn}:${step}`))
    if (Number.isSafeInteger(turn)) {
      keys.push(chatKey('turn-tail', String(turn)))
      keys.push(chatKey('turn-process', String(turn)))
    }
  } else if (event.type === 'tool/result') {
    const callId = event.data?.message?.source?.callId
    if (typeof callId === 'string' && callId !== '') keys.push(chatKey('tool-call', callId))
  }
  return keys
}

/** The `data-chat-turn` values covered by one shadowed surface event. */
function turnOfEvent(session, event) {
  if (Number.isSafeInteger(event.data?.turn)) return event.data.turn
  return turnStepOf(session, event.seq).turn
}

/**
 * The edit transaction itself: shadow everything from the edited message to
 * the current surface tail, and splice in the edited message.
 *
 * @param session - live Session.
 * @param edit - the pending edit.
 * @returns committed coordinates for the client and the log.
 */
function commitEdit(session, edit) {
  const located = locateSurfaceMessage(session, edit.messageId)
  if (located === undefined) {
    throw coded('not-found', 'Tin nhắn này không còn nằm trong hội thoại đang hoạt động (có thể đã bị sửa hoặc nén trước đó).')
  }
  const nodes = surfaceNodes(session)
  const start = located.seq
  const end = nodes[nodes.length - 1]
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw coded('internal', 'Không xác định được khoảng cắt trên surface.')
  }
  const shadowed = nodes.slice(located.index)
  const original = located.event.data
  const message = {
    id: randomUUID(),
    role: 'user',
    // A composer-driven edit owns the whole content list (text plus the images
    // still attached there); a plain text edit keeps every non-text block.
    content: Array.isArray(edit.content) ? edit.content : rebuildContent(original.content, edit.text),
    source: {
      kind: 'user',
      rpcId: edit.rpcId,
      ...(typeof original.source?.clientTimeZone === 'string' ? { clientTimeZone: original.source.clientTimeZone } : {}),
      editOf: edit.messageId,
      editSeq: start
    }
  }
  const event = session.append('user/message', message, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: shadowed
  })
  const hiddenKeys = []
  const hiddenTurns = new Set()
  for (const seq of shadowed) {
    const shadowedEvent = session.eventAt(seq)
    if (shadowedEvent === undefined) continue
    for (const key of chatKeysOf(session, shadowedEvent)) if (!hiddenKeys.includes(key)) hiddenKeys.push(key)
    const turn = turnOfEvent(session, shadowedEvent)
    if (Number.isSafeInteger(turn)) hiddenTurns.add(turn)
  }
  return {
    seq: event.seq,
    editedId: message.id,
    from: edit.messageId,
    start,
    end,
    shadowedSeqs: shadowed,
    shadowedCount: shadowed.length,
    hiddenKeys,
    hiddenTurns: [...hiddenTurns].sort((left, right) => left - right)
  }
}

/**
 * Whether two attachment references address the same stored image. The ref
 * shape is the attachment store's own; identity is compared on the id pair and
 * falls back to structural equality so a store that adds fields still matches.
 */
function sameAttachment(left, right) {
  if (left === undefined || right === undefined || left === null || right === null) return false
  if (typeof left.attachmentId === 'string' && typeof right.attachmentId === 'string') {
    return left.attachmentId === right.attachmentId && String(left.variantId ?? '') === String(right.variantId ?? '')
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * Build the edited content of an existing message: the text is replaced, every
 * other block keeps its place, and an image the user removed from the edit
 * frame is dropped. An edit never introduces a new attachment.
 */
function contentForEdit(originalContent, text, keepImages) {
  const blocks = []
  let placed = false
  for (const block of Array.isArray(originalContent) ? originalContent : []) {
    if (block?.type === 'text') {
      if (placed) continue
      placed = true
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block?.type === 'image' && keepImages !== null
      && keepImages.some((ref) => sameAttachment(ref, block.attachment)) === false) continue
    blocks.push(block)
  }
  if (!placed && text !== '') blocks.push({ type: 'text', text })
  return blocks
}

// ---------------------------------------------------------------------------
// the regenerating turn
// ---------------------------------------------------------------------------

/**
 * Append the replacement as the first step of the next turn, then let that
 * step build its request from the rewritten surface with no new user message.
 */
function installPreStepHook(ctx) {
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    const decision = await next()
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return decision
    const edit = pendingEdits.get(sessionId)
    if (edit === undefined) return decision
    pendingEdits.delete(sessionId)
    if (edit.timer !== undefined) clearTimeout(edit.timer)
    let bumped = false
    try {
      if (decision.kind === 'reject') throw coded('rejected', 'Harness từ chối bước tái sinh.')
      const claimed = new Set(Array.isArray(messages) ? messages : [])
      const kept = (Array.isArray(decision.messages) ? decision.messages : []).filter((message) => !claimed.has(message))
      // An edit owns the step: the claimed batch is suppressed, and the loop
      // must not fall into its "step 1 with nothing claimed completes the turn"
      // branch. Mark the step as already open BEFORE the log changes, so a
      // harness that refuses the write leaves the conversation untouched
      // instead of truncating without regenerating.
      if (kept.length === 0) {
        const phase = agent.phase
        if (phase === undefined || phase.kind !== 'running' || phase.step !== 0) {
          throw coded('unsupported', 'Harness không cho phép chèn bước tái sinh vào lượt này.')
        }
        phase.step = step
        bumped = true
      }
      const committed = commitEdit(agent.session, edit)
      const record = { ...committed, at: Date.now() }
      const history = editHistory.get(sessionId) ?? []
      history.push(record)
      editHistory.set(sessionId, history)
      ctx.logger?.info?.(`[nyx-message-edit] ${sessionId}: replaced surface ${committed.start}-${committed.end} with seq ${committed.seq} (${committed.shadowedCount} nodes shadowed)`)
      edit.resolve?.(record)
      return { ...decision, messages: kept }
    } catch (error) {
      // Nothing was committed, so restore the turn's own step accounting and
      // let the loop behave exactly as it would without an edit.
      if (bumped && agent.phase?.kind === 'running') agent.phase.step = 0
      ctx.logger?.warn?.(`[nyx-message-edit] edit failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      void diag(ctx, {
        sessionId: String(sessionId).slice(0, 48),
        messageId: String(edit.messageId).slice(0, 48),
        phase: 'failed',
        code: typeof error?.code === 'string' ? error.code : 'internal',
        reason: error instanceof Error ? error.message : String(error)
      })
      edit.reject?.(error)
      return decision
    }
  })
}

/** Wake one regenerating turn for a session whose surface was just rewritten. */
function startRegeneration(agent) {
  if (agent.phase?.kind !== 'idle') return false
  if (typeof agent.wakeDriver === 'function') {
    agent.wakeDriver(false)
    return true
  }
  return false
}

/** Stop a running turn with the harness's own user-cancel semantics. */
function interrupt(agent) {
  if (agent.phase?.kind === 'idle') return
  agent.cancel({ kind: 'user' }, { keepInbox: true })
}

/**
 * Wait until the agent holds no turn and no queued input. An edit must be the
 * first thing a turn sees, otherwise a queued prompt would be consumed by the
 * regenerating step instead of running as its own turn.
 */
async function waitForQuiet(agent, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const idle = agent.phase?.kind === 'idle'
    const pending = agent.inbox?.hasPending === true
    if (idle && !pending) return true
    if (typeof agent.whenIdle === 'function') {
      await Promise.race([agent.whenIdle().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 400))])
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return agent.phase?.kind === 'idle' && agent.inbox?.hasPending !== true
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

/** @param {any} ctx */
function resolveAgent(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw coded('bad-request', 'sessionId is required')
  const agents = ctx.get('agents')
  const agent = agents?.get?.(sessionId)
  if (agent === undefined || agent === null) throw coded('not-found', `session "${sessionId}" is not attached to a live agent`)
  return agent
}

/**
 * Every transcript row this session's edits removed, derived from the durable
 * log — the same answer before and after a reload, with no in-memory state.
 */
function hiddenFromLog(session) {
  const keys = []
  const turns = new Set()
  for (const event of session.ownEvents()) {
    if (event.type !== 'user/message') continue
    if (event.surfaceOp === undefined || event.surfaceOp === 'append') continue
    if (typeof event.data?.source?.editOf !== 'string') continue
    const seqs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    for (const seq of seqs) {
      const shadowed = session.eventAt(seq)
      if (shadowed === undefined) continue
      for (const key of chatKeysOf(session, shadowed)) if (!keys.includes(key)) keys.push(key)
      const turn = turnOfEvent(session, shadowed)
      if (Number.isSafeInteger(turn)) turns.add(turn)
    }
  }
  return { keys, turns: [...turns].sort((left, right) => left - right) }
}

/**
 * The provider/model/effort the session last built a request with, read from the
 * request header the harness recorded — the same source the composer's own
 * selector reads.
 * @param {any} session
 * @returns {{provider: string, model: string, effort?: string} | null}
 */
function currentModelOf(session) {
  const config = session?.requestHeader?.()?.config
  if (config === null || config === undefined) return null
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === 'string' ? { effort: config.reasoningEffort } : {})
  }
}

/** @param {any} ctx @param {any} request */
async function handleState(ctx, request) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const agent = resolveAgent(ctx, sessionId)
  const session = agent.session
  const nodes = surfaceNodes(session)
  const messages = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const images = (Array.isArray(event.data.content) ? event.data.content : [])
      .filter((block) => block?.type === 'image' && block.attachment !== undefined)
      .map((block) => block.attachment)
    messages.push({
      id: event.data.id,
      seq: event.seq,
      text: messageText(event.data.content),
      images,
      editable: event.data?.source?.editOf === undefined || typeof event.data.source.editOf === 'string',
      editOf: typeof event.data?.source?.editOf === 'string' ? event.data.source.editOf : null
    })
  }
  const history = editHistory.get(sessionId) ?? []
  const hidden = hiddenFromLog(session)
  return ok({
    build: BUILD,
    sessionId,
    status: agent.status ?? 'unknown',
    // The model the last request went out with, so the edit frame can say which
    // one a re-run would use before the reader changes it.
    model: currentModelOf(session),
    messages,
    hiddenKeys: hidden.keys,
    hiddenTurns: hidden.turns,
    edits: history.map((record) => ({ seq: record.seq, from: record.from, editedId: record.editedId, start: record.start, end: record.end, shadowedCount: record.shadowedCount })),
    surfaceNodes: nodes.length
  })
}

/** @param {any} ctx @param {any} request */
async function handleEdit(ctx, request) {
  const body = await request.json().catch(() => null)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
  const text = typeof body?.text === 'string' ? body.text : ''
  const keepImages = Array.isArray(body?.keepImages) ? body.keepImages : null
  const diagBase = {
    sessionId: sessionId.slice(0, 48),
    messageId: messageId.slice(0, 48),
    textLength: text.length,
    text: text.slice(0, 80),
    keepImages: keepImages === null ? null : keepImages.length,
    bodyKeys: body !== null && typeof body === 'object' ? Object.keys(body).join(',') : null
  }
  // Before anything can refuse it. A request that leaves no trace is
  // indistinguishable from a click that never reached this plugin at all.
  await diag(ctx, { ...diagBase, phase: 'request' })
  try {
    return await performEdit(ctx, { body, sessionId, messageId, text, keepImages, diagBase })
  } catch (error) {
    await diag(ctx, {
      ...diagBase,
      phase: 'failed',
      code: typeof error?.code === 'string' ? error.code : 'internal',
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 240)
    })
    throw error
  }
}

/** The edit itself, with the attempt already recorded by the caller. */
async function performEdit(ctx, { body, sessionId, messageId, text, keepImages, diagBase }) {
  if (body === null || typeof body !== 'object') throw coded('bad-request', 'a JSON body is required')
  if (messageId === '') throw coded('bad-request', 'messageId is required')
  const agent = resolveAgent(ctx, sessionId)
  const session = agent.session
  const located = locateSurfaceMessage(session, messageId)
  if (located === undefined) throw coded('not-found', 'Tin nhắn này không còn nằm trong hội thoại đang hoạt động.')
  const originalContent = Array.isArray(located.event.data.content) ? located.event.data.content : []
  const content = keepImages === null ? undefined : contentForEdit(originalContent, text, keepImages)
  if (content !== undefined && content.length === 0) throw coded('bad-request', 'Tin nhắn không được để trống.')

  // Unchanged edit: nothing to truncate, nothing to regenerate.
  const originalImages = originalContent.filter((block) => block?.type === 'image')
  if (text === messageText(originalContent)
    && (keepImages === null || keepImages.length === originalImages.length)
    && pendingEdits.has(sessionId) === false) {
    await diag(ctx, { ...diagBase, phase: 'unchanged', status: agent.status })
    return ok({ changed: false, reason: 'identical' })
  }
  if (pendingEdits.has(sessionId)) throw coded('busy', 'Đang có một lần sửa khác chạy trên phiên này.')
  const base = { ...diagBase, status: agent.status }

  // Editing while a response streams (or while prompts are queued) is legal:
  // interrupt the running turn with the harness's own user-cancel semantics,
  // then let the queue drain so the edit owns the next step outright.
  if (agent.status !== 'idle' || agent.inbox?.hasPending === true) {
    interrupt(agent)
    const quiet = await waitForQuiet(agent, 60000)
    if (!quiet) throw coded('busy', 'Agent còn lượt đang chạy hoặc còn tin nhắn trong hàng đợi. Thử lại sau khi nó rảnh hẳn.')
  }

  const requested = Date.now()
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingEdits.get(sessionId)?.timer !== timer) return
      pendingEdits.delete(sessionId)
      reject(coded('timeout', 'Hết thời gian chờ harness mở bước tái sinh.'))
    }, 20000)
    pendingEdits.set(sessionId, {
      resolve,
      reject,
      timer,
      messageId,
      text,
      ...(content === undefined ? {} : { content }),
      rpcId: typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : randomUUID(),
      requested
    })
  })

  const started = startRegeneration(agent)
  if (started !== true) {
    await diag(ctx, { ...base, phase: 'refused', code: 'busy', reason: 'agent could not start a turn' })
    const pending = pendingEdits.get(sessionId)
    if (pending !== undefined) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pendingEdits.delete(sessionId)
    }
    throw coded('busy', 'Agent đang bận ở trạng thái không thể bắt đầu bước tái sinh. Thử lại sau khi lượt hiện tại dừng hẳn.')
  }
  const committed = await promise
  await ctx.get('sessions')?.flush?.(session)
  await diag(ctx, { ...base, phase: 'committed', seq: committed.seq, shadowed: committed.shadowedCount })
  return ok({ changed: true, ...committed, requestedAt: requested })
}

/** @param {any} ctx */
function handleHealth(ctx) {
  return ok({
    build: BUILD,
    pending: pendingEdits.size,
    sessions: editHistory.size,
    hasAgents: ctx.get('agents') !== undefined
  })
}

/**
 * The client's own trace, written to the same file as the host's. The two sides
 * of a failed edit are one story, and it has to be readable in one place.
 * @param {any} ctx @param {any} request
 */
async function handleDiag(ctx, request) {
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return ok({ logged: false })
  const record = { ...body, from: 'client' }
  await diag(ctx, record)
  return ok({ logged: true })
}

/** @param {any} error */
function failure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'not-found') return fail(code, message, 404)
  if (code === 'bad-request') return fail(code, message, 400)
  if (code === 'busy') return fail(code, message, 409)
  if (code === 'timeout') return fail(code, message, 504)
  return fail(code, message, 500)
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  installPreStepHook(ctx)
  const connection = ctx.get('connection')
  if (connection === undefined) {
    ctx.logger?.warn?.('[nyx-message-edit] connection service unavailable; routes not registered')
    return
  }
  const guard = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      ctx.logger?.debug?.(`[nyx-message-edit] ${request.url} failed: ${error instanceof Error ? error.message : String(error)}`)
      return failure(error)
    }
  }
  const routes = [
    [ROUTE_STATE, ['GET'], guard((request) => handleState(ctx, request))],
    [ROUTE_EDIT, ['POST'], guard((request) => handleEdit(ctx, request))],
    [ROUTE_HEALTH, ['GET'], guard(() => Promise.resolve(handleHealth(ctx)))],
    [ROUTE_DIAG, ['POST'], guard((request) => handleDiag(ctx, request))]
  ]
  for (const [path, methods, fetchHandler] of routes) {
    connection.fetch.register({ path, methods, fetch: fetchHandler })
  }
  // The file exists from the moment the plugin is alive, so a path quoted to the
  // reader is a path that opens — including before the first edit is ever tried.
  void diag(ctx, { phase: 'loaded', build: BUILD })
  ctx.logger?.info?.(`[nyx-message-edit] ${BUILD} ready on /api/nyx-message-edit.*`)
}
