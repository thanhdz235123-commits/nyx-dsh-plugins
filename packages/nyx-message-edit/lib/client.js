/**
 * nyx-message-edit — client half.
 *
 * Adds a real Edit action to every user message in the Chat transcript:
 *
 *   pencil → inline editor (Cancel / Send) → POST /api/nyx-message-edit.edit
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
  id: 'nyx-message-edit',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const CLIENT_BUILD = '0.1.0'
    const STYLE_ID = 'nyx-message-edit-style'
    const HIDDEN_STYLE_ID = 'nyx-message-edit-hidden'
    const EDITOR_ID = 'nyx-message-edit-editor'
    const PENCIL_ID = 'nyx-message-edit-pencil'
    const NODE_KIND = 'nyx-message-edit'
    /**
     * Flow-key kind prefixes that carry a message id. `input-message` is the
     * harness's own user row; `nyx-message-edit` is the row this plugin renders
     * for an already-edited message — without it an edited message could never
     * be edited again.
     */
    const USER_KIND_PREFIXES = ['input-message', 'nyx-message-edit', 'steering']
    /**
     * The picker's marks, copied verbatim from `@deepseek-ai/dsh-client-ui-primitives`
     * (`IconChevronDownOutline14`, `IconChevronRightOutline14`, `IconCheckOutline16`,
     * `IconSearchOutline16`) — the composer's own chip and menu are drawn with these
     * marks, so an edit frame is drawn with them too.
     */
    const CHEVRON_DOWN_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
    const CHEVRON_RIGHT_PATH = 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z'
    const CHECK_PATH = 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z'
    const SEARCH_PATH = 'M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z'

    const POLL_INTERVAL_MS = 1500
    /** Marks a Trajectory turn whose messages an edit has replaced. */
    const REPLACED_ATTR = 'data-dme-replaced'
    const REPLACED_TITLE = 'Turn này đã bị thay thế bằng một bản sửa — nó không còn nằm trong context.'
    const REPLACED_CSS = `
/* A turn an edit replaced, in the Trajectory view: the log keeps it, so the
   reader gets told it is history rather than context. The dimming sits on the
   row's own text nodes (not the cell) so the label stays readable. */
tr[${REPLACED_ATTR}="true"] > td:last-child > * { opacity: .42; text-decoration: line-through; text-decoration-thickness: 1px; }
tr[${REPLACED_ATTR}="true"][data-turn-start="true"] > td:first-child { color: var(--dsw-alias-text-3, currentColor); }
tr[${REPLACED_ATTR}="true"][data-turn-start="true"] > td:last-child { padding-right: 104px; }
tr[${REPLACED_ATTR}="true"][data-turn-start="true"] > td:last-child::after {
  content: "đã thay thế";
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  padding: 1px 7px; border-radius: 999px;
  font-size: 10px; line-height: 15px; white-space: nowrap;
  letter-spacing: .01em; opacity: 1;
  color: var(--dsw-alias-state-warning-primary, #d9a13b);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d9a13b) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d9a13b) 16%, transparent);
}`
    const LABELS = {
      edit: 'Sửa tin nhắn',
      cancel: 'Hủy bỏ',
      send: 'Gửi',
      sending: 'Đang gửi…',
      hint: 'Esc để hủy · ⌘/Ctrl+Enter để gửi',
      failed: 'Sửa tin nhắn thất bại',
      removeImage: 'Gỡ ảnh này',
      emptyHint: 'Gõ nội dung (hoặc giữ ảnh) để gửi',
      unchanged: 'Nội dung chưa đổi — sửa chữ rồi gửi lại',
      model: 'Model',
      effort: 'Effort',
      modelKeep: 'Model hiện tại',
      modelSearch: 'Tìm model…',
      modelNoEffort: 'Model này không có mức effort'
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
      const response = await fetch(`/api/nyx-message-edit.state?sessionId=${encodeURIComponent(sessionId)}`)
      const payload = await response.json().catch(() => null)
      if (payload?.ok !== true) throw new Error(payload?.error?.message ?? `state failed (${response.status})`)
      return payload.value
    }

    /**
     * Leave the client's half of the story in the host's trace file. A click
     * that never becomes a request is the one failure the host cannot see.
     */
    function postDiag(facts) {
      try {
        void fetch('/api/nyx-message-edit.diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ build: CLIENT_BUILD, ...facts })
        }).catch(() => {})
      } catch {
        /* the trace never breaks the edit */
      }
    }

    async function postEdit(sessionId, messageId, text, keepImages) {
      const body = { sessionId, messageId, text, requestId: crypto.randomUUID() }
      // Present (even empty) tells the host which of the message's own images
      // stay; images can only be dropped by an edit, never added.
      if (Array.isArray(keepImages)) body.keepImages = keepImages
      const response = await fetch('/api/nyx-message-edit.edit', {
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


    /** The host's model catalog, shared by every frame opened in this page. */
    let modelCatalog = null
    let modelCatalogAt = 0

    async function loadModelCatalog(ctx) {
      if (modelCatalog !== null && Date.now() - modelCatalogAt < 60000) return modelCatalog
      const answer = await ctx.remote?.session?.modelCatalog?.()
      if (answer?.ok !== true) throw new Error(answer?.error?.message ?? 'model catalog unavailable')
      modelCatalog = answer.value
      modelCatalogAt = Date.now()
      return modelCatalog
    }

    /**
     * The picker's two marks, drawn with the same paths, view boxes and sizes as
     * `@deepseek-ai/dsh-client-ui-primitives`' `IconChevronDownOutline14` and
     * `IconCheckOutline16` — the composer's chip uses those exact glyphs.
     */
    /** One of the primitives' own marks, built from its exact path data. */
    function iconMark(viewBox, size, path) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', viewBox)
      svg.setAttribute('width', String(size))
      svg.setAttribute('height', String(size))
      svg.setAttribute('aria-hidden', 'true')
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      node.setAttribute('d', path)
      node.setAttribute('fill', 'currentColor')
      svg.append(node)
      return svg
    }

    /** One catalog entry, addressed the way a choice is. */
    function modelKey(provider, model) {
      return `${provider}\u0000${model}`
    }

    /**
     * The frame's model picker, built to the app's own `ModelSelect` module: the
     * same 28px pill trigger, the same two-level menu (a `Model` cell and an
     * `Effort` cell opening their own panes), the same search row, the same
     * 38px option rows and check mark — and the same placement: above the chip,
     * an 8px gap, the menu's right edge on the chip's right edge.
     *
     * The chip always names the model that would answer, with its effort, exactly
     * as the composer's chip does.
     *
     * @returns {{row: HTMLElement, value: () => string, label: () => string}}
     */
    function mountModelPicker(ctx, sessionId, current) {
      const row = document.createElement('div')
      row.className = 'dme-model-row'

      const trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.className = 'dme-model-trigger'
      trigger.dataset.dmeAction = 'model'
      trigger.setAttribute('aria-haspopup', 'menu')
      trigger.setAttribute('aria-expanded', 'false')
      const nameNode = document.createElement('span')
      nameNode.className = 'dme-model-name'
      const effortNode = document.createElement('span')
      effortNode.className = 'dme-model-effort'
      const chevron = iconMark('0 0 14 14', 14, CHEVRON_DOWN_PATH)
      chevron.setAttribute('class', 'dme-model-chevron')
      trigger.append(nameNode, effortNode, chevron)

      const menu = document.createElement('div')
      menu.className = 'dme-model-menu'
      menu.setAttribute('role', 'menu')
      menu.hidden = true
      const body = document.createElement('div')
      body.className = 'dme-model-body'
      menu.append(body)
      row.append(trigger, menu)

      /** @type {Map<string, {name: string, efforts: Array<{id: string, name: string}>, defaultEffort: string | null}>} */
      const entries = new Map()
      const baseline = current === null || current === undefined
        ? null
        : { provider: current.provider, model: current.model, ...(typeof current.effort === 'string' ? { effort: current.effort } : {}) }
      let selection = baseline === null ? null : { ...baseline }
      let pane = 'root'
      let open = false

      const entryOf = (value) => (value === null ? undefined : entries.get(modelKey(value.provider, value.model)))
      const modelLabelOf = (value) => (value === null ? LABELS.modelKeep : entryOf(value)?.name ?? value.model)
      const effortsOf = (value) => (value === null ? [] : entryOf(value)?.efforts ?? [])
      const effortLabelOf = (value) => {
        if (value === null || typeof value.effort !== 'string' || value.effort === '') return ''
        const level = effortsOf(value).find((item) => item.id === value.effort)
        return level?.name ?? value.effort
      }

      /** The chip says what would answer: model first, effort beside it. */
      const paintTrigger = () => {
        const label = modelLabelOf(selection)
        nameNode.textContent = label
        nameNode.title = label
        const effort = effortLabelOf(selection)
        effortNode.textContent = effort === '' ? '' : ` ${effort}`
      }

      /** Does the reader's current choice differ from what the session already uses? */
      const changed = () => {
        if (baseline === null) return selection !== null
        if (selection === null) return baseline !== null
        return selection.provider !== baseline.provider
          || selection.model !== baseline.model
          || (selection.effort ?? null) !== (baseline.effort ?? null)
      }

      const place = () => {
        const rect = trigger.getBoundingClientRect()
        const box = menu.getBoundingClientRect()
        const margin = 12
        const gap = 8
        const roomAbove = rect.top - margin
        const above = roomAbove >= Math.min(box.height, 300)
        const top = above
          ? Math.max(margin, rect.top - box.height - gap)
          : Math.min(rect.bottom + gap, window.innerHeight - box.height - margin)
        // The app hangs its menu off the trigger's right edge (`right: 0`); keep
        // that edge when the window allows it, and slide in when it does not.
        const right = rect.right
        const left = Math.max(margin, Math.min(right - box.width, window.innerWidth - box.width - margin))
        menu.style.top = `${Math.round(top)}px`
        menu.style.left = `${Math.round(left)}px`
      }

      const focusable = () => [...body.querySelectorAll('.dme-model-cell, .dme-model-option, .dme-model-search-input')]

      const focusFirst = (backwards = false) => {
        const list = focusable()
        const target = backwards ? list[list.length - 1] : list[0]
        target?.focus()
      }

      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (pane !== 'root') {
            pane = 'root'
            renderBody()
            focusFirst()
            return
          }
          close()
          trigger.focus()
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const list = focusable().filter((node) => node.hidden !== true)
        if (list.length === 0) return
        const at = list.indexOf(document.activeElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const from = at < 0 ? (step === 1 ? -1 : 0) : at
        list[(((from + step) % list.length) + list.length) % list.length].focus()
      }

      const onOutside = (event) => {
        if (menu.contains(event.target) === true || trigger.contains(event.target) === true) return
        close()
      }

      /**
       * The root pane: one cell per level of the choice, exactly as the app's menu
       * opens — `Model` with the model in use, `Effort` when that model has any.
       */
      const cell = (kind, label, value, onOpen) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dme-model-cell'
        button.setAttribute('role', 'menuitem')
        button.dataset.dmeCell = kind
        const labelNode = document.createElement('span')
        labelNode.className = 'dme-model-cell-label'
        labelNode.textContent = label
        const valueNode = document.createElement('span')
        valueNode.className = 'dme-model-cell-value'
        valueNode.textContent = value
        const mark = iconMark('0 0 14 14', 14, CHEVRON_RIGHT_PATH)
        mark.setAttribute('class', 'dme-model-cell-chevron')
        button.append(labelNode, valueNode, mark)
        button.addEventListener('click', onOpen)
        return button
      }

      /** The search row the app puts above its model list. */
      const searchRow = () => {
        const holder = document.createElement('label')
        holder.className = 'dme-model-search'
        const icon = iconMark('0 0 16 16', 16, SEARCH_PATH)
        icon.setAttribute('class', 'dme-model-search-icon')
        const input = document.createElement('input')
        input.type = 'search'
        input.className = 'dme-model-search-input'
        input.placeholder = LABELS.modelSearch
        input.setAttribute('aria-label', LABELS.modelSearch)
        input.autocomplete = 'off'
        input.spellcheck = false
        input.addEventListener('input', () => filter(input.value))
        holder.append(icon, input)
        window.setTimeout(() => input.focus(), 0)
        return holder
      }

      /** Filter the rows already on screen: rebuilding them would drop the caret. */
      const filter = (query) => {
        const wanted = query.trim().toLowerCase()
        for (const section of body.querySelectorAll('.dme-model-group')) {
          let shown = 0
          for (const option of section.querySelectorAll('.dme-model-option')) {
            const hit = wanted === '' || (option.dataset.modelName ?? '').toLowerCase().includes(wanted)
            option.hidden = hit !== true
            if (hit) shown += 1
          }
          section.hidden = shown === 0
        }
      }

      /** One option row: the model's name, and the check when it is the choice. */
      const optionRow = (id, label, checked, onPick) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dme-model-option'
        button.setAttribute('role', 'menuitemradio')
        button.setAttribute('aria-checked', checked ? 'true' : 'false')
        button.dataset.modelKey = id
        button.dataset.modelName = label
        button.title = label
        const copy = document.createElement('span')
        copy.className = 'dme-model-copy'
        const text = document.createElement('span')
        text.className = 'dme-model-option-name'
        text.textContent = label
        copy.append(text)
        const slot = document.createElement('span')
        slot.className = 'dme-model-check'
        if (checked) slot.append(iconMark('0 0 16 16', 16, CHECK_PATH))
        button.append(copy, slot)
        button.addEventListener('click', onPick)
        return button
      }

      const modelPane = () => {
        const holder = document.createElement('div')
        holder.className = 'dme-model-pane'
        holder.append(searchRow())
        const groups = document.createElement('div')
        groups.className = 'dme-model-groups'
        for (const group of catalogGroups) {
          if (group.models.length === 0) continue
          const section = document.createElement('section')
          section.className = 'dme-model-group'
          section.setAttribute('role', 'group')
          const title = document.createElement('div')
          title.className = 'dme-model-group-title'
          title.textContent = group.name
          section.append(title)
          for (const model of group.models) {
            const key = modelKey(group.id, model.id)
            const chosen = selection !== null && selection.provider === group.id && selection.model === model.id
            section.append(optionRow(key, model.name, chosen, () => {
              // A model keeps the effort in use when it knows that effort, and
              // otherwise falls back to its own default — never to a guess.
              const keeps = selection !== null && model.efforts.some((item) => item.id === selection.effort)
              const effort = keeps ? selection.effort : model.defaultEffort
              selection = { provider: group.id, model: model.id, ...(typeof effort === 'string' && effort !== '' ? { effort } : {}) }
              paintTrigger()
              close()
              trigger.focus()
            }))
          }
          groups.append(section)
        }
        holder.append(groups)
        return holder
      }

      const effortPane = () => {
        const groups = document.createElement('div')
        groups.className = 'dme-model-groups'
        const levels = effortsOf(selection)
        if (levels.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'dme-model-status'
          empty.textContent = LABELS.modelNoEffort
          groups.append(empty)
          return groups
        }
        for (const level of levels) {
          const chosen = selection !== null && (selection.effort ?? '') === level.id
          groups.append(optionRow(`effort\u0000${level.id}`, level.name, chosen, () => {
            selection = { ...(selection ?? {}), effort: level.id }
            paintTrigger()
            close()
            trigger.focus()
          }))
        }
        return groups
      }

      function renderBody() {
        body.textContent = ''
        if (pane === 'root') {
          body.append(cell('model', LABELS.model, modelLabelOf(selection), () => { pane = 'model'; renderBody(); focusFirst() }))
          if (effortsOf(selection).length > 0) {
            body.append(cell('effort', LABELS.effort, effortLabelOf(selection), () => { pane = 'effort'; renderBody(); focusFirst() }))
          }
          return
        }
        body.append(pane === 'model' ? modelPane() : effortPane())
      }

      function close() {
        if (open !== true) return
        open = false
        menu.hidden = true
        trigger.setAttribute('aria-expanded', 'false')
        window.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('scroll', place, true)
        window.removeEventListener('resize', place)
      }

      const show = () => {
        if (open === true) return
        open = true
        pane = 'root'
        renderBody()
        menu.hidden = false
        trigger.setAttribute('aria-expanded', 'true')
        place()
        requestAnimationFrame(place)
        window.addEventListener('pointerdown', onOutside, true)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
      }

      trigger.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (open) close()
        else show()
      })

      /** The catalog, flattened into the groups the menu renders. */
      let catalogGroups = []
      const fill = (catalog) => {
        catalogGroups = []
        entries.clear()
        for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
          const models = []
          for (const model of Array.isArray(group?.models) ? group.models : []) {
            const efforts = []
            for (const item of Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []) {
              if (typeof item?.id === 'string') efforts.push({ id: item.id, name: typeof item.name === 'string' ? item.name : item.id })
            }
            const entry = {
              name: typeof model.name === 'string' && model.name !== '' ? model.name : String(model.id),
              efforts,
              defaultEffort: typeof model?.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : null
            }
            entries.set(modelKey(group.id, model.id), entry)
            models.push({ id: model.id, name: entry.name, efforts, defaultEffort: entry.defaultEffort })
          }
          catalogGroups.push({
            id: group.id,
            name: typeof group.name === 'string' && group.name !== '' ? group.name : String(group.id ?? ''),
            models
          })
        }
        paintTrigger()
      }

      void loadModelCatalog(ctx).then(fill).catch((error) => {
        trigger.disabled = true
        trigger.title = error instanceof Error ? error.message : String(error)
      })
      paintTrigger()

      return {
        row,
        pane: (kind) => {
          if (kind !== 'root' && kind !== 'model' && kind !== 'effort') return null
          if (open !== true) show()
          pane = kind
          renderBody()
          return focusable().map((node) => (node.textContent ?? '').trim())
        },
        value: () => (changed() !== true || selection === null ? '' : modelKey(selection.provider, selection.model) + (selection.effort === undefined ? '' : `\u0000${selection.effort}`)),
        label: () => trigger.textContent
      }
    }

    /**
     * Hand the harness the model this re-run should use. This is the same call the
     * composer's own picker makes, so the session's selection — and every request
     * after it — agrees with what the frame said it would do.
     * @returns {Promise<{provider: string, model: string} | null>} null when the reader kept the current model.
     */
    async function applyModelChoice(ctx, sessionId, value) {
      if (typeof value !== 'string' || value === '') return null
      const [provider, model, effort] = value.split('\u0000')
      if (provider === undefined || model === undefined || provider === '' || model === '') return null
      const call = ctx.remote?.session?.selectModel
      if (typeof call !== 'function') throw new Error('phiên này không đổi được model')
      const answer = await call({
        sessionId,
        provider,
        model,
        ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort })
      })
      if (answer?.ok === false) throw new Error(`${answer.error?.code ?? 'error'}: ${answer.error?.message ?? 'đổi model thất bại'}`)
      return { provider, model }
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
     * Paint the Trajectory view's rows that belong to a turn an edit replaced.
     *
     * The Trajectory renders the durable log itself, so a replaced turn keeps its
     * rows there — which is what an audit trail is for, and exactly why a reader
     * cannot tell it apart from a live one. Those rows are dimmed, struck through
     * and labelled at the turn they open, so nobody has to wonder whether the old
     * text is still in the conversation. It is not: only the surface is sent.
     */
    function paintReplacedTurns(state) {
      if (typeof document === 'undefined') return 0
      const rows = document.querySelectorAll('tr[data-trajectory-row-key]')
      if (rows.length === 0) return 0
      for (const row of rows) {
        if (row.getAttribute(REPLACED_ATTR) === 'true') row.removeAttribute(REPLACED_ATTR)
        if (row.getAttribute('title') === REPLACED_TITLE) row.removeAttribute('title')
      }
      const starts = new Set()
      for (const edit of state?.edits ?? []) {
        const start = Number(edit?.start)
        if (Number.isSafeInteger(start)) starts.add(start)
      }
      if (starts.size === 0) return 0
      const all = [...rows]
      let marked = 0
      for (let index = 0; index < all.length; index += 1) {
        if (carriesReplacedMessage(all[index], starts) !== true) continue
        // One turn is one block of rows: it opens at the replaced message's row
        // and runs until the next turn opens (or the current one closes).
        let from = index
        while (from > 0 && all[from].dataset.turnStart !== 'true') from -= 1
        let to = from
        while (to + 1 < all.length && all[to + 1].dataset.turnStart !== 'true' && all[to].dataset.turnEnd !== 'true') to += 1
        for (let at = from; at <= to; at += 1) {
          all[at].setAttribute(REPLACED_ATTR, 'true')
          all[at].setAttribute('title', REPLACED_TITLE)
          marked += 1
        }
      }
      return marked
    }

    /**
     * Does one Trajectory row carry the identity of a message an edit replaced?
     * The row key is the log's own (`user\0seq\0<seq>`), and an edit records the
     * seq it replaced, so the two meet on the seq — never on a guess.
     */
    function carriesReplacedMessage(row, starts) {
      const raw = row.dataset.trajectoryRowKey
      if (typeof raw !== 'string' || raw === '') return false
      let key = raw
      try {
        key = decodeURIComponent(raw)
      } catch {
        /* not encoded: read it as written */
      }
      const parts = key.split('\u0000')
      if (parts[0] !== 'user' || parts[1] !== 'seq') return false
      return starts.has(Number(parts[2]))
    }

    /** One coalesced repaint, so a scrolling Trajectory never paints per row. */
    let replacedTimer = null
    function scheduleReplacedPaint() {
      if (replacedTimer !== null) return
      replacedTimer = window.setTimeout(() => {
        replacedTimer = null
        paintReplacedTurns(stateSnapshot())
      }, 200)
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
      const next = `${selectors.length === 0 ? '' : `${selectors.join(',')}{display:none !important}`}${REPLACED_CSS}`
      if (element.textContent !== next) element.textContent = next
      paintReplacedTurns(state)
    }

    function applyState(state) {
      cached = state === null ? null : { key: state.sessionId, state, at: Date.now() }
      paintHidden(state)
      for (const listener of stateListeners) {
        try {
          listener(state)
        } catch (error) {
          console.warn('[nyx-message-edit] listener failed:', error)
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
      element.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.7 2.3a1.6 1.6 0 0 1 2.3 2.3l-7.4 7.4-3 .7.7-3 7.4-7.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
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
      const size = 28
      const gap = 8
      const { actions, bubble } = anchorsOf(hovered.row)
      let top = null
      let left = null
      if (actions !== null && actions.getBoundingClientRect().width > 0) {
        // Sit in the row itself, on the action buttons' own baseline: one slot
        // after the last one, which is where an edit action belongs and the only
        // free space in the row (what sits before Copy is the message's time).
        const buttons = [...actions.querySelectorAll('button')]
        const last = buttons[buttons.length - 1] ?? actions
        const rect = last.getBoundingClientRect()
        top = rect.top + (rect.height - size) / 2
        left = rect.right + gap
        if (left + size > window.innerWidth - gap) {
          // No room after the row (a window edge): fall back to its first slot.
          const first = (buttons[0] ?? actions).getBoundingClientRect()
          top = first.top + (first.height - size) / 2
          left = first.left - size - gap
        }
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

      // A re-run is a new answer, and a new answer may deserve another model:
      // the picker below hands the harness the same selection its own composer
      // picker does, so the regenerating request leaves on the chosen one.
      const modelPicker = mountModelPicker(ctx, sessionId, stateSnapshot()?.model ?? null)

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

      card.append(imageRow, textarea, modelPicker.row, status, actions)
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
      postDiag({
        phase: 'open',
        sessionId,
        messageId,
        key,
        textLength: initialText.length,
        images: keptImages.length
      })

      let busy = false
      const syncSend = () => {
        const empty = textarea.value.trim() === ''
        send.disabled = busy || (empty && keptImages.length === 0)
        hint.textContent = empty && keptImages.length === 0 ? LABELS.emptyHint : LABELS.hint
      }

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
            syncSend()
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
        postDiag({
          phase: 'press',
          sessionId,
          messageId,
          textLength: textarea.value.length,
          keptImages: keptImages.length,
          model: modelPicker.value() === '' ? null : modelPicker.value().split('\u0000').join('/'),
          key
        })
        try {
          const chosen = await applyModelChoice(ctx, sessionId, modelPicker.value())
          if (chosen !== null) postDiag({ phase: 'model', messageId, provider: chosen.provider, model: chosen.model })
          const result = await postEdit(sessionId, messageId, textarea.value, keptImages)
          postDiag({ phase: 'sent', messageId, changed: result?.changed !== false, seq: result?.seq ?? null, reason: result?.reason ?? null })
          // An edit that changes nothing is not an edit: keep the frame open and
          // say so, instead of closing on a click that produced no result.
          if (result?.changed === false) {
            busy = false
            cancel.disabled = false
            send.textContent = LABELS.send
            status.textContent = LABELS.unchanged
            syncSend()
            return
          }
          closeEditor()
          await refresh(ctx, true)
        } catch (error) {
          postDiag({
            phase: 'client-failed',
            messageId,
            code: error?.code ?? 'error',
            message: String(error?.message ?? error).slice(0, 200)
          })
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
        console.warn('[nyx-message-edit] state refresh failed:', error?.message ?? error)
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
/* Dressed as the transcript's own action button — the measurements the Copy
   and Share buttons under a message use: 28px round, 6px of padding around a
   15px mark, transparent until hovered, label-tertiary ink. */
#${PENCIL_ID} {
  position: fixed; z-index: 2147482900; display: none; place-items: center;
  box-sizing: border-box; width: 28px; height: 28px; padding: 0; margin: 0;
  border: none; border-radius: 28px; background: none;
  color: var(--dsw-alias-label-tertiary, #adb2b8);
  cursor: pointer; touch-action: none;
  transition: color .1s linear, background .1s linear;
}
#${PENCIL_ID}:hover { color: var(--dsw-alias-label-primary, #fff); background: var(--dsw-alias-interactive-bg-hover, #3a3a40); }
#${PENCIL_ID}:active { background: var(--dsw-alias-state-business-primary, #4d6bfe); color: #fff; }
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
#${EDITOR_ID} .dme-model-row { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
/* The chip and the menu follow the app's own ModelSelect: a 28px pill trigger,
   a 20px-radius menu on the menu token, 40px cells, 38px option rows, and the
   app's own search row above the model list. */
#${EDITOR_ID} .dme-model-trigger {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  max-width: min(360px, 45vw); height: 28px; padding: 0 4px 0 8px; border: none;
  border-radius: 24px; background: none; cursor: pointer; outline: none;
  color: var(--dsw-alias-label-secondary);
  font: 500 13px/20px Inter, var(--dsw-font-family), sans-serif;
}
#${EDITOR_ID} .dme-model-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
#${EDITOR_ID} .dme-model-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
#${EDITOR_ID} .dme-model-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
#${EDITOR_ID} .dme-model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${EDITOR_ID} .dme-model-effort { flex: none; color: var(--dsw-alias-label-caption); }
#${EDITOR_ID} .dme-model-chevron { flex: none; color: var(--dsw-alias-label-caption); transition: transform .12s; }
#${EDITOR_ID} .dme-model-trigger[aria-expanded="true"] .dme-model-chevron { transform: rotate(180deg); }
#${EDITOR_ID} .dme-model-menu {
  position: fixed; z-index: 2147483001; display: flex; flex-direction: column;
  width: max-content; min-width: min(240px, 100vw - 32px); max-width: min(420px, 100vw - 32px);
  max-height: min(360px, 100vh - 96px); padding: 4px; overflow: hidden;
  border: 0; border-radius: 20px; background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary);
}
#${EDITOR_ID} .dme-model-menu[hidden] { display: none; }
#${EDITOR_ID} .dme-model-body { display: flex; flex-direction: column; min-height: 0; }
#${EDITOR_ID} .dme-model-cell {
  box-sizing: border-box; display: flex; align-items: center; gap: 8px;
  width: auto; min-width: 100%; height: 40px; padding: 0 10px; border: none;
  border-radius: 10px; background: none; color: var(--dsw-alias-label-primary);
  text-align: left; cursor: pointer; outline: none;
  font: 400 14px/22px Inter, var(--dsw-font-family), sans-serif;
}
#${EDITOR_ID} .dme-model-cell:hover, #${EDITOR_ID} .dme-model-cell:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
#${EDITOR_ID} .dme-model-cell-label { flex: none; white-space: nowrap; }
#${EDITOR_ID} .dme-model-cell-value {
  flex: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: right; color: var(--dsw-alias-label-tertiary);
}
#${EDITOR_ID} .dme-model-cell-chevron { flex: none; color: var(--dsw-alias-label-tertiary); }
#${EDITOR_ID} .dme-model-search {
  box-sizing: border-box; display: flex; align-items: center; gap: 7px; flex: none;
  height: 36px; margin: 2px 4px 4px; padding: 0 9px;
  border: 1px solid transparent; border-radius: 9px;
  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-tertiary);
}
#${EDITOR_ID} .dme-model-search:focus-within { border-color: var(--dsw-alias-border-l2); background: var(--dsw-specific-menu); }
#${EDITOR_ID} .dme-model-search-icon { flex: none; }
#${EDITOR_ID} .dme-model-search-input {
  width: 100%; min-width: 0; padding: 0; border: none; outline: none; background: none;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px;
}
#${EDITOR_ID} .dme-model-search-input::placeholder { color: var(--dsw-alias-label-caption); }
#${EDITOR_ID} .dme-model-pane { display: flex; flex-direction: column; min-height: 0; }
#${EDITOR_ID} .dme-model-groups { min-height: 0; overflow-y: auto; }
#${EDITOR_ID} .dme-model-group + .dme-model-group { margin-top: 4px; }
#${EDITOR_ID} .dme-model-group-title {
  position: sticky; top: 0; z-index: 1; padding: 5px 8px 3px;
  background: var(--dsw-specific-menu); color: var(--dsw-alias-label-tertiary);
  font: 500 12px/18px Inter, var(--dsw-font-family), sans-serif;
}
#${EDITOR_ID} .dme-model-status { padding: 10px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
#${EDITOR_ID} .dme-model-option {
  box-sizing: border-box; display: flex; align-items: center; gap: 8px;
  width: auto; min-width: 100%; min-height: 38px; padding: 6px 8px;
  border: none; border-radius: 10px; background: none; color: inherit;
  text-align: left; cursor: pointer; outline: none;
}
#${EDITOR_ID} .dme-model-option[hidden] { display: none; }
#${EDITOR_ID} .dme-model-option:hover:not(:disabled), #${EDITOR_ID} .dme-model-option:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}
#${EDITOR_ID} .dme-model-option:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
#${EDITOR_ID} .dme-model-copy { display: flex; flex-direction: column; flex: 1; min-width: 0; }
#${EDITOR_ID} .dme-model-option-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 500 14px/20px Inter, var(--dsw-font-family), sans-serif;
}
#${EDITOR_ID} .dme-model-check {
  display: grid; place-items: center; flex: 0 0 18px; color: var(--dsw-alias-label-primary);
}
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
          ctx.effect(() => ctx.uiConversation.events.register(editDefinition), 'nyx-message-edit conversation node')
        } else {
          console.warn('[nyx-message-edit] uiConversation unavailable; edited messages will not render')
        }
      } catch (error) {
        console.warn('[nyx-message-edit] conversation node registration failed:', error?.message ?? error)
      }

      stateCtx = ctx
      pencilElement()
      document.addEventListener('pointermove', onPointerMove, true)
      // The transcript scrolls under the button; keep it glued to its message.
      // No `pointerleave` listener anywhere: a leave fires for every descendant
      // the pointer crosses, which is what made the button blink away.
      window.addEventListener('scroll', onViewportChange, true)
      window.addEventListener('resize', onViewportChange)

      // The Trajectory virtualizes its rows: scrolling can put a replaced turn
      // back on screen with no state change to trigger a repaint.
      const replacedObserver = new MutationObserver(() => {
        if (stateSnapshot()?.edits?.length > 0
          && document.querySelector('tr[data-trajectory-row-key]') !== null) scheduleReplacedPaint()
      })
      replacedObserver.observe(document.body, { childList: true, subtree: true })

      ctx.effect(() => () => {
        closeEditor()
        hidePencil()
        document.removeEventListener('pointermove', onPointerMove, true)
        window.removeEventListener('scroll', onViewportChange, true)
        window.removeEventListener('resize', onViewportChange)
        replacedObserver.disconnect()
        if (replacedTimer !== null) {
          clearTimeout(replacedTimer)
          replacedTimer = null
        }
        if (pollTimer !== null) clearInterval(pollTimer)
        stateCtx = null
      }, 'nyx-message-edit DOM listeners')

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
        modelOptions: () => [...document.querySelectorAll('#nyx-message-edit-editor .dme-model-option')]
          .map((option) => ({ value: option.dataset.modelKey ?? '', label: option.textContent })),
        modelTrigger: () => {
          const trigger = document.querySelector('#nyx-message-edit-editor .dme-model-trigger')
          if (trigger === null) return null
          return { text: trigger.textContent, expanded: trigger.getAttribute('aria-expanded'), disabled: trigger.disabled }
        },
        openModelMenu: () => {
          const trigger = document.querySelector('#nyx-message-edit-editor .dme-model-trigger')
          if (trigger === null) return false
          trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
          return true
        },
        modelMenuBox: () => {
          const menu = document.querySelector('#nyx-message-edit-editor .dme-model-menu')
          if (menu === null || menu.hidden) return null
          const box = menu.getBoundingClientRect()
          return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
        },
        chooseModel: (value) => {
          const option = [...document.querySelectorAll('#nyx-message-edit-editor .dme-model-option')]
            .find((node) => (node.dataset.modelKey ?? '') === value)
          if (option === undefined) return false
          option.click()
          return true
        },
        modelCells: () => [...document.querySelectorAll('#nyx-message-edit-editor .dme-model-cell')]
          .map((node) => ({ kind: node.dataset.dmeCell ?? '', label: node.textContent ?? '' })),
        sendEditor: () => {
          const host = document.getElementById(EDITOR_ID)
          const button = host?.querySelector('[data-dme-action="send"]')
          if (button === undefined) return false
          button.click()
          return true
        },
        hiddenKeys: () => (stateSnapshot()?.hiddenKeys ?? []),
        editableMessages: () => editableMessages(),
        /** Trajectory rows currently marked as belonging to a replaced turn. */
        replacedRows: () => document.querySelectorAll(`tr[${REPLACED_ATTR}="true"]`).length,
        paintReplacedTurns: () => paintReplacedTurns(stateSnapshot()),
        chatKey,
        messageIdOfKey
      }
      console.log(`[nyx-message-edit] client ${CLIENT_BUILD} loaded`)
    }

    const inject = ['sessions', 'uiConversation', 'remote', 'remote.session']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
