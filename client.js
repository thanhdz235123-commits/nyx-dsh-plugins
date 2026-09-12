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
    /**
     * Flow-key kind prefixes that carry a message id. `input-message` is the
     * harness's own user row; `dsh-message-edit` is the row this plugin renders
     * for an already-edited message — without it an edited message could never
     * be edited again.
     */
    const USER_KIND_PREFIXES = ['input-message', 'dsh-message-edit', 'steering']
    const POLL_INTERVAL_MS = 1500
    const LABELS = {
      edit: 'Sửa tin nhắn',
      cancel: 'Hủy bỏ',
      send: 'Gửi',
      sending: 'Đang gửi…',
      hint: 'Esc để hủy · ⌘/Ctrl+Enter để gửi',
      failed: 'Sửa tin nhắn thất bại',
      removeImage: 'Gỡ ảnh này'
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
      for (const prefix of USER_KIND_PREFIXES) {
        if (!tail.startsWith(prefix)) continue
        const id = tail.slice(prefix.length)
        return id === '' ? null : id
      }
      return null
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

    async function postEdit(sessionId, messageId, text, keepImages) {
      const body = { sessionId, messageId, text, requestId: crypto.randomUUID() }
      // Present (even empty) tells the host which of the message's own images
      // stay; images can only be dropped by an edit, never added.
      if (Array.isArray(keepImages)) body.keepImages = keepImages
      const response = await fetch('/api/dsh-message-edit.edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
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

    /**
     * The two anchors a row offers.
     *
     * `actions` is the time/copy cluster DSH renders UNDER the bubble, which is
     * the only reliably free space around a message: the bubble itself is
     * right-aligned and can be only a few dozen pixels wide, so anchoring to the
     * row's right edge parks the button on top of the user's own text.
     */
    function anchorsOf(row) {
      const slot = row.firstElementChild
      const userRow = slot === null ? null : slot.firstElementChild
      const candidate = userRow === null ? null : userRow.lastElementChild
      const actions = candidate !== null && candidate.querySelector('button') !== null ? candidate : null
      const images = row.querySelector('[data-slot="conversation.message.images"]')
      return { actions, bubble: images === null ? null : images.nextElementSibling }
    }

    function positionPencil() {
      if (hovered === null) return
      const element = pencilElement()
      const rowRect = hovered.row.getBoundingClientRect()
      if (rowRect.width === 0 && rowRect.height === 0) {
        hidePencil()
        return
      }
      const size = 30
      const gap = 8
      const { actions, bubble } = anchorsOf(hovered.row)
      let top = null
      let left = null
      if (actions !== null && actions.getBoundingClientRect().width > 0) {
        const rect = actions.getBoundingClientRect()
        top = rect.top + (rect.height - size) / 2
        left = rect.left - size - gap
      }
      if (left === null || left < gap) {
        const rect = bubble === null ? rowRect : bubble.getBoundingClientRect()
        top = rect.top + (rect.height - size) / 2
        left = rect.left - size - gap
      }
      if (left < gap) {
        // No gutter on the left at all: fall back to under the actions cluster.
        const rect = actions === null ? rowRect : actions.getBoundingClientRect()
        top = rect.bottom + 4
        left = rect.left
      }
      top = Math.round(Math.min(Math.max(gap, top), Math.max(gap, window.innerHeight - size - gap)))
      left = Math.round(Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - size - gap)))
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
      if (!row.isConnected || message === undefined) return
      hidePencil()
      closeEditor()
      openEditor(stateCtx, row, messageId, message)
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
    let editorTimer = null
    let editorPlacement = ''

    function closeEditor() {
      if (editorHost !== null) {
        editorHost.remove()
        editorHost = null
      }
      editorPlacement = ''
      stopEditorTracking()
      window.removeEventListener('keydown', onEditorKey, true)
      window.removeEventListener('scroll', repositionEditor, true)
      window.removeEventListener('resize', repositionEditor, true)
    }

    /**
     * Keep the frame welded to the message it belongs to.
     *
     * An edit is bound to one message in one session: the frame follows that
     * row while the transcript scrolls, and retires the moment the row is gone
     * or the window is showing a different session. It is never left floating
     * over an unrelated conversation.
     */
    function repositionEditor() {
      if (editorHost === null) return
      const anchor = editorHost.dataset.anchor ?? ''
      if (anchor === '') return
      if (editorHost.dataset.session !== sessionIdOf(stateCtx)) {
        closeEditor()
        return
      }
      const row = document.querySelector(`[data-chat-flow-key="${anchor.replace(/"/g, '\\"')}"]`)
      if (row === null) {
        closeEditor()
        return
      }
      const rect = row.getBoundingClientRect()
      // The row unpainted (detached, collapsed, or virtualised away) or scrolled
      // fully out of the scrollport: the message is not on screen, so neither is
      // its editor.
      if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight) {
        closeEditor()
        return
      }
      const width = Math.round(Math.min(Math.max(440, rect.width), 860))
      const left = Math.max(8, Math.min(Math.round(rect.right - width), window.innerWidth - width - 8))
      // Vertical position follows the message; it only lifts when the frame
      // itself would fall off the bottom, so Send never leaves the screen.
      const height = editorHost.firstElementChild?.getBoundingClientRect().height ?? 0
      const wanted = Math.round(rect.top - 4)
      const top = height > 0 ? Math.max(8, Math.min(wanted, window.innerHeight - height - 8)) : Math.max(8, wanted)
      const geometry = `${top}:${left}:${width}`
      if (geometry === editorPlacement) return
      editorPlacement = geometry
      editorHost.style.top = `${top}px`
      editorHost.style.left = `${left}px`
      editorHost.style.width = `${width}px`
    }

    /** Re-check binding without waiting for a scroll or resize event. */
    function startEditorTracking() {
      stopEditorTracking()
      editorTimer = window.setInterval(repositionEditor, 150)
    }

    function stopEditorTracking() {
      if (editorTimer === null) return
      clearInterval(editorTimer)
      editorTimer = null
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
     * Turn one message row into a temporary edit frame, the way ChatGPT does:
     * the frame sits exactly where the message was, holds its images with a
     * remove button each, the text in a textarea, and Cancel / Send.
     *
     * Only the text is editable and images can only be dropped — matching the
     * original UX, where new attachments come from a new message, not an edit.
     *
     * @param ctx - owning client context.
     * @param row - the transcript row being edited.
     * @param messageId - durable id of the message.
     * @param message - the host-reported message, carrying text and images.
     */
    function openEditor(ctx, row, messageId, message) {
      closeEditor()
      const sessionId = sessionIdOf(ctx)
      if (sessionId === null) return
      const key = row.dataset.chatFlowKey ?? ''
      const initialText = typeof message?.text === 'string' ? message.text : ''
      /** Images the user has not removed yet; sent back so the host keeps exactly these. */
      let keptImages = Array.isArray(message?.images) ? [...message.images] : []

      const host = document.createElement('div')
      host.id = EDITOR_ID
      host.dataset.anchor = key
      host.dataset.session = sessionId
      host.style.cssText = 'position:fixed;z-index:2147483000;'

      const card = document.createElement('div')
      card.className = 'dme-card'

      const imageRow = document.createElement('div')
      imageRow.className = 'dme-images'

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

      card.append(imageRow, textarea, status, actions)
      host.appendChild(card)
      // Bring the message being edited into view first: the frame anchors to the
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
      startEditorTracking()

      // --- images: thumbnail + remove, loaded through the harness image cache
      const renderImages = () => {
        imageRow.textContent = ''
        imageRow.style.display = keptImages.length === 0 ? 'none' : 'flex'
        for (const [index, attachment] of keptImages.entries()) {
          const chip = document.createElement('div')
          chip.className = 'dme-chip'
          const image = document.createElement('img')
          image.alt = ''
          chip.appendChild(image)
          const remove = document.createElement('button')
          remove.type = 'button'
          remove.className = 'dme-chip-x'
          remove.title = LABELS.removeImage
          remove.setAttribute('aria-label', LABELS.removeImage)
          remove.textContent = '×'
          remove.addEventListener('pointerdown', (event) => {
            event.preventDefault()
            event.stopPropagation()
            keptImages = keptImages.filter((_, position) => position !== index)
            renderImages()
            repositionEditor()
          })
          chip.appendChild(remove)
          imageRow.appendChild(chip)
          void ctx.uiConversation
            .imageUrl(sessionId, attachment)
            .then((url) => { image.src = url })
            .catch(() => { chip.classList.add('dme-chip-broken') })
        }
      }
      renderImages()

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
        cancel.disabled = true
        send.textContent = LABELS.sending
        syncSend()
        status.textContent = ''
        try {
          await postEdit(sessionId, messageId, textarea.value, keptImages)
          closeEditor()
          await refresh(ctx, true)
        } catch (error) {
          busy = false
          cancel.disabled = false
          send.textContent = LABELS.send
          status.textContent = `${LABELS.failed}: ${error.message}`
          syncSend()
        }
      })

      window.addEventListener('keydown', onEditorKey, true)
      window.addEventListener('scroll', repositionEditor, true)
      window.addEventListener('resize', repositionEditor, true)
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
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
  box-sizing: border-box; width: 100%; padding: 12px 14px 10px;
  border: .5px solid var(--dsw-alias-border-l1, #303036); border-radius: 18px;
  background: var(--dsw-specific-tip, #26262a);
  box-shadow: var(--dsw-elevation-panel, 0 6px 24px rgba(0,0,0,.35));
  display: flex; flex-direction: column; gap: 10px;
}
#${EDITOR_ID} .dme-images { display: flex; flex-wrap: wrap; gap: 8px; }
#${EDITOR_ID} .dme-chip { position: relative; width: 68px; height: 68px; flex: none; }
#${EDITOR_ID} .dme-chip img {
  display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l1, #303036); background: var(--dsw-alias-bg-base, #17171a);
}
#${EDITOR_ID} .dme-chip-broken img { opacity: .35; }
#${EDITOR_ID} .dme-chip-x {
  position: absolute; top: -6px; right: -6px; box-sizing: border-box;
  width: 22px; height: 22px; padding: 0; display: grid; place-items: center;
  cursor: pointer; border: none; border-radius: 999px;
  background: var(--dsw-alias-button-floating-fill, #3a3a40); color: var(--dsw-alias-label-primary, #fff);
  font: 400 15px/1 Inter, sans-serif;
  box-shadow: var(--dsw-elevation-panel, 0 2px 8px rgba(0,0,0,.4));
  opacity: .9; transition: background .12s linear, opacity .12s linear;
}
#${EDITOR_ID} .dme-chip-x:hover { background: var(--dsw-alias-state-error-primary, #ff6b6b); opacity: 1; }
#${EDITOR_ID} .dme-chip-x:focus-visible { outline: 2px solid var(--dsw-alias-label-tertiary, #8b8d98); outline-offset: 1px; }
#${EDITOR_ID} .dme-input {
  box-sizing: border-box; width: 100%; min-height: 26px; max-height: 320px; resize: none;
  padding: 0 2px; margin: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary, #fff); overflow-y: auto;
  font-family: Inter, var(--dsw-font-family, sans-serif);
  font-size: var(--dsh-content-font-size, 15px); line-height: 1.55;
}
#${EDITOR_ID} .dme-input::placeholder { color: var(--dsw-alias-label-caption, #77787f); }
#${EDITOR_ID} .dme-status {
  font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px;
  color: var(--dsw-alias-state-error-primary, #ff6b6b);
}
#${EDITOR_ID} .dme-status:empty { display: none; }
#${EDITOR_ID} .dme-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
#${EDITOR_ID} .dme-hint {
  margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 16px; color: var(--dsw-alias-label-caption, #77787f);
}
#${EDITOR_ID} .dme-button {
  height: 32px; padding: 0 16px; border-radius: 16px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l1, #303036); background: transparent;
  color: var(--dsw-alias-label-primary, #fff);
  font: 500 13px/20px Inter, var(--dsw-font-family), sans-serif;
  transition: background .12s linear, opacity .12s linear;
}
#${EDITOR_ID} .dme-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #3a3a40); }
#${EDITOR_ID} .dme-button:disabled { opacity: .45; cursor: default; }
#${EDITOR_ID} .dme-primary {
  border-color: transparent; background: var(--dsw-alias-button-info-fill, #4d6bfe); color: #fff;
}
#${EDITOR_ID} .dme-primary:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover, #3f5cf0); }
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
        openEditorFor: (messageId) => {
          const row = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
            .find((element) => messageIdOfKey(element.dataset.chatFlowKey) === messageId)
          const message = editableMessages().find((entry) => entry.id === messageId)
          if (row === undefined || message === undefined) return false
          openEditor(ctx, row, messageId, message)
          return true
        },
        editorState: () => {
          const host = document.getElementById(EDITOR_ID)
          if (host === null) return null
          return {
            value: host.querySelector('textarea')?.value ?? null,
            chips: host.querySelectorAll('.dme-chip').length,
            chipsWithImage: [...host.querySelectorAll('.dme-chip img')].filter((img) => img.src !== '').length,
            buttons: [...host.querySelectorAll('.dme-actions button')].map((button) => button.textContent)
          }
        },
        removeChip: (index) => {
          const host = document.getElementById(EDITOR_ID)
          const chip = host?.querySelectorAll('.dme-chip')?.[index]
          if (chip === undefined) return false
          chip.querySelector('.dme-chip-x')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
          return true
        },
        sendEditor: () => {
          const host = document.getElementById(EDITOR_ID)
          const button = host?.querySelector('[data-dme-action="send"]')
          if (button === undefined) return false
          button.click()
          return true
        },
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
