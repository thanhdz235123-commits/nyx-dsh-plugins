/**
 * dsh-message-edit — client half.
 *
 * Adds a real Edit action to every user message in the Chat transcript:
 *
 *   pencil → inline editor (Cancel / Send) → POST /api/dsh-message-edit.edit
 *
 * The host half owns the conversation semantics (surface truncation + replace
 * + one regenerating turn). This half owns presentation only:
 *
 *  - the replacement event the host appends renders through the harness's own
 *    `user` Chat renderer, so the edited message looks native;
 *  - the transcript rows the edit removed are hidden from the durable log
 *    state the host reports, so a reload never resurrects them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-message-edit',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const CLIENT_BUILD = '0.1.0'
    const STYLE_ID = 'dsh-message-edit-style'
    const HIDDEN_STYLE_ID = 'dsh-message-edit-hidden'
    const EDITOR_ID = 'dsh-message-edit-editor'
    const PENCIL_ID = 'dsh-message-edit-pencil'
    const NODE_KIND = 'dsh-message-edit'
    const USER_KIND_PREFIX = 'input-message'
    const POLL_INTERVAL_MS = 1500
    const LABELS = {
      edit: 'Sửa tin nhắn',
      cancel: 'Hủy bỏ',
      send: 'Gửi',
      sending: 'Đang gửi…',
      hint: 'Esc để hủy · ⌘/Ctrl+Enter để gửi',
      failed: 'Sửa tin nhắn thất bại'
    }

    /** The Chat transcript's row identity, as `conversationContextKey` composes it. */
    function chatKey(kind, id) {
      return `${kind.length}:${kind}${id}`
    }

    /** Message id carried by one `input-message` flow key, or null. */
    function messageIdOfKey(key) {
      if (typeof key !== 'string') return null
      const separator = key.indexOf(':')
      if (separator < 0) return null
      const tail = key.slice(separator + 1)
      if (!tail.startsWith(USER_KIND_PREFIX)) return null
      const id = tail.slice(USER_KIND_PREFIX.length)
      return id === '' ? null : id
    }

    // ------------------------------------------------------------------
    // state — what the host says the conversation currently is
    // ------------------------------------------------------------------

    /** @type {{ key: string, state: any, at: number } | null} */
    let cached = null
    let stateListeners = new Set()

    function sessionIdOf(ctx) {
      const list = ctx?.get?.('sessions')?.list?.getSnapshot?.()
      const current = list?.current ?? null
      return typeof current === 'string' && current !== '' ? current : null
    }

    async function fetchState(sessionId) {
      const response = await fetch(`/api/dsh-message-edit.state?sessionId=${encodeURIComponent(sessionId)}`)
      const payload = await response.json().catch(() => null)
      if (payload?.ok !== true) throw new Error(payload?.error?.message ?? `state failed (${response.status})`)
      return payload.value
    }

    async function postEdit(sessionId, messageId, text) {
      const response = await fetch('/api/dsh-message-edit.edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, messageId, text, requestId: crypto.randomUUID() })
      })
      const payload = await response.json().catch(() => null)
      if (payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? `edit failed (${response.status})`)
        error.code = payload?.error?.code ?? 'error'
        throw error
      }
      return payload.value
    }

    // ------------------------------------------------------------------
    // transcript decoration
    // ------------------------------------------------------------------

    function componentStyleElement() {
      let element = document.getElementById(STYLE_ID)
      if (element === null) {
        element = document.createElement('style')
        element.id = STYLE_ID
        document.head.appendChild(element)
      }
      return element
    }

    /** Own element: the hidden-row sheet is rewritten on every refresh. */
    function hiddenStyleElement() {
      let element = document.getElementById(HIDDEN_STYLE_ID)
      if (element === null) {
        element = document.createElement('style')
        element.id = HIDDEN_STYLE_ID
        document.head.appendChild(element)
      }
      return element
    }

    /**
     * Hide exactly the rows the harness's surface fold no longer contains.
     * Rows are addressable by their own `data-chat-flow-key`, and whole turns
     * by `data-chat-turn`; both come straight from the durable log.
     */
    function paintHidden(state) {
      const selectors = []
      for (const turn of state?.hiddenTurns ?? []) selectors.push(`[data-chat-flow] > [data-chat-turn="${String(turn)}"]`)
      for (const key of state?.hiddenKeys ?? []) selectors.push(`[data-chat-flow] > [data-chat-flow-key="${String(key).replace(/"/g, '\\"')}"]`)
      const element = hiddenStyleElement()
      const next = selectors.length === 0 ? '' : `${selectors.join(',')}{display:none !important}`
      if (element.textContent !== next) element.textContent = next
    }

    function applyState(state) {
      cached = state === null ? null : { key: state.sessionId, state, at: Date.now() }
      paintHidden(state)
      for (const listener of stateListeners) {
        try {
          listener(state)
        } catch (error) {
          console.warn('[dsh-message-edit] listener failed:', error)
        }
      }
    }

    function stateSnapshot() {
      return cached?.state ?? null
    }

    /** The editable user messages the host reports for the current session. */
    function editableMessages() {
      const state = stateSnapshot()
      if (state === null || !Array.isArray(state.messages)) return []
      return state.messages
    }

    // ------------------------------------------------------------------
    // the pencil and the inline editor
    // ------------------------------------------------------------------

    function rowAt(node) {
      const element = node instanceof Element ? node : null
      if (element === null) return null
      const row = element.closest('[data-chat-flow-kind="user"]')
      if (row === null) return null
      const id = messageIdOfKey(row.dataset.chatFlowKey)
      if (id === null) return null
      if (!editableMessages().some((message) => message.id === id)) return null
      return { row, messageId: id }
    }

    function pencilElement() {
      let element = document.getElementById(PENCIL_ID)
      if (element !== null) return element
      element = document.createElement('button')
      element.id = PENCIL_ID
      element.type = 'button'
      element.title = LABELS.edit
      element.setAttribute('aria-label', LABELS.edit)
      element.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.7 2.3a1.6 1.6 0 0 1 2.3 2.3l-7.4 7.4-3 .7.7-3 7.4-7.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
      // The button owns its own keep/hide: leaving a row must never take it
      // away while the pointer is travelling towards it.
      element.addEventListener('pointerenter', () => keepPencil())
      element.addEventListener('pointerleave', () => releasePencil())
      element.addEventListener('pointerdown', (event) => {
        // pointerdown, not click: the message under the pointer can re-render
        // between press and release, and a lost click here is a lost edit.
        event.preventDefault()
        event.stopPropagation()
        openFromPencil()
      })
      document.body.appendChild(element)
      return element
    }

    /** The row the pencil is currently offered for (kept after hiding, so a
     *  press always has a target even if the pointer moved a pixel). */
    let hovered = null
    let hoverTimer = null
    let trackTimer = null
    /** Set once the plugin is applied; the pencil press needs it. */
    let stateCtx = null
    /** Last written geometry, so tracking never rewrites identical values. */
    let placed = ''

    function keepPencil() {
      if (hoverTimer !== null) {
        clearTimeout(hoverTimer)
        hoverTimer = null
      }
    }

    function releasePencil() {
      keepPencil()
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null
        hidePencil()
      }, 450)
    }

    function positionPencil() {
      if (hovered === null) return
      const element = pencilElement()
      const rect = hovered.row.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        hidePencil()
        return
      }
      const size = 30
      const top = Math.round(rect.top + Math.min(8, Math.max(0, rect.height / 2 - size / 2)))
      const left = Math.round(Math.min(rect.right - size - 8, window.innerWidth - size - 8))
      const geometry = `${top}:${left}`
      if (geometry !== placed) {
        placed = geometry
        element.style.top = `${top}px`
        element.style.left = `${left}px`
      }
      if (element.style.display !== 'grid') element.style.display = 'grid'
    }

    function hidePencil() {
      const element = document.getElementById(PENCIL_ID)
      if (element !== null && element.style.display !== 'none') element.style.display = 'none'
      placed = ''
      stopTracking()
    }

    /** Keep the button glued to its message while the transcript scrolls,
     *  resizes, or re-renders underneath it. */
    function startTracking() {
      if (trackTimer !== null) return
      trackTimer = window.setInterval(() => {
        if (hovered === null) {
          stopTracking()
          return
        }
        positionPencil()
      }, 120)
    }

    function stopTracking() {
      if (trackTimer === null) return
      clearInterval(trackTimer)
      trackTimer = null
    }

    function offerPencil(target) {
      hovered = target
      positionPencil()
      startTracking()
    }

    function onPointerMove(event) {
      const target = event.target
      const element = document.getElementById(PENCIL_ID)
      if (element !== null && element.contains(target)) {
        keepPencil()
        return
      }
      const row = rowAt(target)
      if (row === null) {
        if (element !== null && element.style.display === 'grid') releasePencil()
        return
      }
      keepPencil()
      // Always (re)offer: the button may have been hidden by opening the editor,
      // and positionPencil only writes when the geometry actually changed.
      offerPencil({ messageId: row.messageId, row: row.row })
    }

    function openFromPencil() {
      if (hovered === null) return
      const row = hovered.row
      const messageId = hovered.messageId
      const message = editableMessages().find((entry) => entry.id === messageId)
      if (!row.isConnected) return
      hidePencil()
      closeEditor()
      openEditor(stateCtx, row, messageId, message?.text ?? '')
    }

    function onViewportChange() {
      if (hovered === null) return
      positionPencil()
    }

    // ------------------------------------------------------------------
    // editor overlay
    // ------------------------------------------------------------------

    /** @type {HTMLElement | null} */
    let editorHost = null

    function closeEditor() {
      if (editorHost !== null) {
        editorHost.remove()
        editorHost = null
      }
      window.removeEventListener('keydown', onEditorKey, true)
      window.removeEventListener('scroll', repositionEditor, true)
      window.removeEventListener('resize', repositionEditor, true)
    }

    function repositionEditor() {
      if (editorHost === null) return
      const anchor = editorHost.dataset.anchor
      const row = anchor === undefined || anchor === '' ? null : document.querySelector(`[data-chat-flow-key="${anchor.replace(/"/g, '\\"')}"]`)
      const card = editorHost.firstElementChild
      if (row === null || card === null) return
      const rect = row.getBoundingClientRect()
      const width = Math.min(680, Math.max(360, rect.width))
      const height = card.getBoundingClientRect().height
      const maxTop = Math.max(8, window.innerHeight - height - 8)
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      editorHost.style.top = `${Math.round(Math.min(Math.max(8, rect.top - 4), maxTop))}px`
      editorHost.style.left = `${Math.round(Math.min(Math.max(8, rect.right - width), maxLeft))}px`
      editorHost.style.width = `${width}px`
    }

    function onEditorKey(event) {
      if (editorHost === null) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeEditor()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        event.stopPropagation()
        editorHost.querySelector('[data-dme-action="send"]')?.click()
      }
    }

    /**
     * Open the inline editor over one message row. The row itself stays in
     * place underneath an opaque card, so cancel restores it untouched and no
     * React-owned node is ever mutated.
     */
    function openEditor(ctx, row, messageId, initialText) {
      closeEditor()
      const sessionId = sessionIdOf(ctx)
      if (sessionId === null) return
      const key = row.dataset.chatFlowKey ?? ''
      const host = document.createElement('div')
      host.id = EDITOR_ID
      host.dataset.anchor = key
      host.style.cssText = 'position:fixed;z-index:2147483000;'

      const card = document.createElement('div')
      card.className = 'dme-card'

      const label = document.createElement('div')
      label.className = 'dme-label'
      label.textContent = LABELS.edit

      const textarea = document.createElement('textarea')
      textarea.className = 'dme-input'
      textarea.value = initialText
      textarea.rows = Math.min(14, Math.max(2, initialText.split('\n').length + 1))

      const status = document.createElement('div')
      status.className = 'dme-status'

      const actions = document.createElement('div')
      actions.className = 'dme-actions'
      const hint = document.createElement('span')
      hint.className = 'dme-hint'
      hint.textContent = LABELS.hint
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dme-button'
      cancel.dataset.dmeAction = 'cancel'
      cancel.textContent = LABELS.cancel
      const send = document.createElement('button')
      send.type = 'button'
      send.className = 'dme-button dme-primary'
      send.dataset.dmeAction = 'send'
      send.textContent = LABELS.send
      actions.append(hint, cancel, send)

      card.append(label, textarea, status, actions)
      host.appendChild(card)
      // Bring the message being edited into view first: the card anchors to the
      // row, so opening it off-screen would look like nothing happened.
      try {
        row.scrollIntoView({ block: 'center', inline: 'nearest' })
      } catch {
        /* older engines: the clamp in repositionEditor still keeps it on screen */
      }
      document.body.appendChild(host)
      editorHost = host
      resizeTextarea(textarea)
      repositionEditor()
      requestAnimationFrame(() => repositionEditor())
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)

      let busy = false
      const syncSend = () => {
        send.disabled = busy || textarea.value.trim() === ''
      }
      textarea.addEventListener('input', () => {
        resizeTextarea(textarea)
        syncSend()
      })
      syncSend()
      cancel.addEventListener('click', () => closeEditor())

      send.addEventListener('click', async () => {
        if (busy) return
        busy = true
        send.disabled = true
        cancel.disabled = true
        syncSend()
        send.textContent = LABELS.sending
        status.textContent = ''
        try {
          await postEdit(sessionId, messageId, textarea.value)
          closeEditor()
          await refresh(ctx, true)
        } catch (error) {
          busy = false
          cancel.disabled = false
          send.textContent = LABELS.send
          syncSend()
          status.textContent = `${LABELS.failed}: ${error.message}`
        }
      })

      window.addEventListener('keydown', onEditorKey, true)
      window.addEventListener('scroll', repositionEditor, true)
      window.addEventListener('resize', repositionEditor, true)
    }

    function resizeTextarea(textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(320, Math.max(40, textarea.scrollHeight))}px`
    }

    // ------------------------------------------------------------------
    // polling
    // ------------------------------------------------------------------

    let pollTimer = null
    let pollKey = null

    async function refresh(ctx, force) {
      const sessionId = sessionIdOf(ctx)
      if (sessionId === null) return
      if (force !== true && pollKey === sessionId && document.visibilityState === 'hidden') return
      try {
        const state = await fetchState(sessionId)
        pollKey = sessionId
        const previous = cached?.state
        applyState(state)
        if (previous !== undefined && previous !== null && previous.hiddenKeys.length !== state.hiddenKeys.length) return
      } catch (error) {
        console.warn('[dsh-message-edit] state refresh failed:', error?.message ?? error)
      }
    }

    // ------------------------------------------------------------------
    // conversation node: the edited message renders as a native user bubble
    // ------------------------------------------------------------------

    const editDefinition = {
      kind: NODE_KIND,
      target: 'chat',
      match: (event) => {
        if (event.type !== 'user/message') return null
        if (event.surfaceOp === undefined || event.surfaceOp === 'append') return null
        if (typeof event.data?.source?.editOf !== 'string') return null
        return { id: String(event.data.id), role: 'start' }
      },
      start: (_context, match) => ({
        kind: 'user',
        seq: match.event.seq,
        time: match.event.time,
        content: match.event.data.content,
        source: match.event.data.source
      }),
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === undefined) return null
        return {
          key: context.key,
          kind: 'user',
          id: context.id,
          target: 'chat',
          anchorSeq: context.state.seq,
          location: { kind: 'unresolved' },
          visibility: 'visible',
          data: context.state
        }
      }
    }

    function installStyles() {
      const element = componentStyleElement()
      if (element.dataset.mounted === '1') return
      element.dataset.mounted = '1'
      element.textContent = `
#${PENCIL_ID} {
  position: fixed; z-index: 2147482900; display: none; place-items: center;
  box-sizing: border-box; width: 30px; height: 30px; padding: 0; margin: 0;
  border: .5px solid var(--dsw-alias-border-l3, #3d3d44); border-radius: 999px;
  background: var(--dsw-specific-menu, #2b2b2f); color: var(--dsw-alias-label-secondary, #c3c4cb);
  box-shadow: var(--dsw-elevation-panel, 0 2px 10px rgba(0,0,0,.4));
  cursor: pointer; touch-action: none;
  transition: color .1s linear, background .1s linear, border-color .1s linear;
}
#${PENCIL_ID}:hover { color: #fff; border-color: var(--dsw-alias-label-tertiary, #8b8d98); background: var(--dsw-alias-interactive-bg-hover, #3a3a40); }
#${PENCIL_ID}:active { background: var(--dsw-alias-state-business-primary, #4d6bfe); border-color: transparent; color: #fff; }
#${EDITOR_ID} .dme-card {
  box-sizing: border-box; width: 100%; padding: 10px 12px 8px;
  border: .5px solid var(--dsw-alias-border-l2, #3a3a40); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #1f1f23);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.45));
  display: flex; flex-direction: column; gap: 8px;
}
#${EDITOR_ID} .dme-label { font: var(--dsw-font-xs-strong-13, 500 13px/20px Inter, sans-serif); color: var(--dsw-alias-label-tertiary, #8b8d98); }
#${EDITOR_ID} .dme-input {
  box-sizing: border-box; width: 100%; min-height: 40px; max-height: 320px; resize: none;
  padding: 8px 10px; border: .5px solid var(--dsw-alias-border-l4, #4a4a52); border-radius: 10px;
  background: var(--dsw-alias-bg-base, #17171a); color: var(--dsw-alias-label-primary, #fff);
  font: var(--dsw-font-s-14, 400 14px/22px Inter, sans-serif); outline: none; overflow-y: auto;
}
#${EDITOR_ID} .dme-input:focus { border-color: var(--dsw-alias-state-business-primary, #4d6bfe); }
#${EDITOR_ID} .dme-status { font: var(--dsw-font-xs-13, 400 13px/18px Inter, sans-serif); color: var(--dsw-alias-state-error-primary, #ff6b6b); min-height: 0; }
#${EDITOR_ID} .dme-status:empty { display: none; }
#${EDITOR_ID} .dme-actions { display: flex; align-items: center; gap: 8px; }
#${EDITOR_ID} .dme-hint { flex: auto; font: var(--dsw-font-xxs-12, 400 12px/16px Inter, sans-serif); color: var(--dsw-alias-label-caption, #77787f); }
#${EDITOR_ID} .dme-button {
  height: 30px; padding: 0 14px; border-radius: 15px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l4, #4a4a52); background: transparent;
  color: var(--dsw-alias-label-primary, #fff); font: var(--dsw-font-xs-strong-13, 500 13px/20px Inter, sans-serif);
}
#${EDITOR_ID} .dme-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #3a3a40); }
#${EDITOR_ID} .dme-button:disabled { opacity: .5; cursor: default; }
#${EDITOR_ID} .dme-primary { border-color: transparent; background: var(--dsw-alias-state-business-primary, #4d6bfe); color: #fff; }
#${EDITOR_ID} .dme-primary:hover:not(:disabled) { filter: brightness(1.08); }
`
    }

    /** @param {import('@deepseek-ai/cordis').Context} ctx */
    function apply(ctx) {
      installStyles()
      try {
        if (ctx.uiConversation?.events?.register !== undefined) {
          ctx.effect(() => ctx.uiConversation.events.register(editDefinition), 'dsh-message-edit conversation node')
        } else {
          console.warn('[dsh-message-edit] uiConversation unavailable; edited messages will not render')
        }
      } catch (error) {
        console.warn('[dsh-message-edit] conversation node registration failed:', error?.message ?? error)
      }

      stateCtx = ctx
      pencilElement()
      document.addEventListener('pointermove', onPointerMove, true)
      // The transcript scrolls under the button; keep it glued to its message.
      // No `pointerleave` listener anywhere: a leave fires for every descendant
      // the pointer crosses, which is what made the button blink away.
      window.addEventListener('scroll', onViewportChange, true)
      window.addEventListener('resize', onViewportChange)

      ctx.effect(() => () => {
        closeEditor()
        hidePencil()
        document.removeEventListener('pointermove', onPointerMove, true)
        window.removeEventListener('scroll', onViewportChange, true)
        window.removeEventListener('resize', onViewportChange)
        if (pollTimer !== null) clearInterval(pollTimer)
        stateCtx = null
      }, 'dsh-message-edit DOM listeners')

      void refresh(ctx, true)
      pollTimer = window.setInterval(() => { void refresh(ctx, false) }, POLL_INTERVAL_MS)

      window.__dshMessageEdit = {
        build: CLIENT_BUILD,
        state: () => stateSnapshot(),
        refresh: () => refresh(ctx, true),
        edit: (messageId, text) => {
          const sessionId = sessionIdOf(ctx)
          return postEdit(sessionId, messageId, text)
        },
        openEditor: (messageId) => {
          const row = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
            .find((element) => messageIdOfKey(element.dataset.chatFlowKey) === messageId)
          if (row === undefined) return false
          const message = editableMessages().find((entry) => entry.id === messageId)
          openEditor(ctx, row, messageId, message?.text ?? '')
          return true
        },
        pencilTarget: () => (hovered === null ? null : { messageId: hovered.messageId, connected: hovered.row.isConnected }),
        pencilBox: () => {
          const element = document.getElementById(PENCIL_ID)
          if (element === null) return null
          const rect = element.getBoundingClientRect()
          return { display: element.style.display, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        },
        hoverAt: (x, y) => {
          const target = document.elementFromPoint(x, y)
          if (target === null) return false
          target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
          return true
        },
        closeEditor,
        isEditorOpen: () => editorHost !== null,
        hiddenKeys: () => (stateSnapshot()?.hiddenKeys ?? []),
        editableMessages: () => editableMessages(),
        chatKey,
        messageIdOfKey
      }
      console.log(`[dsh-message-edit] client ${CLIENT_BUILD} loaded`)
    }

    const inject = ['sessions', 'uiConversation']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
