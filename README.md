# dsh-message-edit

Real **edit message** for DeepSeek Harness.

Editing a user message **replaces it in place, cuts everything after it, and regenerates the answer from that exact point** — the way ChatGPT and Claude do it, and the way harness conversations are *supposed* to work.

```
Before                              After editing "hello" → "1"
──────────────────────────────      ──────────────────────────────
User: hello                         User: 1
AI:   hey, what's up?               AI:   [fresh answer to "1"]

User: Python là gì?
AI:   Python là một ngôn ngữ…

User: giải thích thêm
AI:   …
```

Everything from the edited message onward — including **the old answer to that message** — leaves the active conversation and never enters the next request. Nothing is appended at the end.

---

## Install

```sh
npx --yes github:thanhdz235123-commits/dsh-message-edit install
```

Then **restart DSH Desktop** once (the host half registers an Agent hook and its routes at harness start). Later client-only updates just need a window reload.

Other shapes:

```sh
node bin/dsh-message-edit.mjs install --home "/path/to/harness" --profile web
node bin/dsh-message-edit.mjs install --dep        # package.json dependency + bundle
node bin/dsh-message-edit.mjs status
node bin/dsh-message-edit.mjs uninstall
node bin/dsh-message-edit.mjs doctor
```

Works on macOS / Windows / Linux: the harness home is resolved the same way DSH resolves it, and no harness package is imported by the host half.

---

## Use

1. Hover any **user** message in the Chat transcript → a pencil appears at its top-right.
2. Click it. The message turns into an inline editor holding its current text.
3. **Hủy bỏ** / `Esc` cancels — the conversation is untouched.
4. **Gửi** / `⌘`/`Ctrl`+`Enter` applies the edit: the message is replaced where it stood, everything after it disappears, and the model answers the edited message again in the same session.

Editing while a response is still streaming is allowed: the running turn is cancelled with the harness's own stop semantics, then the edit lands.

---

## How it works (harness-native, no parallel conversation store)

DeepSeek Harness keeps an **append-only event log** and derives the model history from its **surface** — an ordered view of the log's message-producing events, where each event declares how it joins the surface (`surfaceOp`).

Edit uses exactly that mechanism:

| Step | Mechanism |
| --- | --- |
| Truncate + replace | one `session.append('user/message', edited, { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs })` where `start` is the edited message's surface node and `end` is the current surface tail |
| Regenerate | `agent.wakeDriver()` opens a normal turn; the plugin's `agent/pre-step` hook returns the step with **no appended user message**, so the request is built from the rewritten surface |
| Request build | untouched — the loop calls `session.deriveMessages()` and hands it to the provider exactly as for any other turn |
| Streaming, model selector, system prompt, tools, thinking, markdown, attachments | untouched |
| Persistence | untouched — the replacement is a normal durable event; the log stays append-only and replayable |
| UI | the replacement event renders through the harness's own `user` Chat renderer, so the edited bubble looks native |

Because the surface fold is what `deriveMessages()` reads, the next request contains **only** the messages before the edit point plus the edited message. Verified against a recording provider stub: editing the first message of `hello / Python là gì? / giải thích thêm` produced a request of exactly `[system, 1]`.

The transcript rows the edit removed are addressed by their own `data-chat-flow-key` / `data-chat-turn` (both derived from the durable log, not from client state), so a reload never resurrects them.

### Why a plugin and not a patch

Nothing in the app bundle is modified. The host half imports **zero** harness packages; it uses the documented plugin surfaces only:

- `connection.fetch.register` for `/api/dsh-message-edit.*`
- `ctx.on('agent/pre-step', …)` — the Agent step waterfall the harness itself uses for prompt assembly
- `session.surface.nodes`, `session.eventAt`, `session.append`, `session.ownEvents`
- `agent.wakeDriver()`, `agent.cancel()`, `agent.whenIdle()`

---

## API (host routes, same-origin, browser-session fenced)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/dsh-message-edit.state?sessionId=` | GET | user messages currently on the surface + the transcript rows earlier edits removed |
| `/api/dsh-message-edit.edit` | POST | `{ sessionId, messageId, text }` → truncate + replace + regenerate |
| `/api/dsh-message-edit.health` | GET | build, pending edits, whether the Agent service is reachable |
| `/api/dsh-message-edit.diag` | POST | client diagnostic sink |

Error codes: `not-found` (message no longer on the surface), `bad-request` (empty text), `busy` (agent could not be quiesced), `timeout`, `unsupported`.

---

## Verified

Run on a real harness instance (same app build as the desktop app) with a recording provider stub for exact-request evidence, and with the real DeepSeek provider for the end-to-end experience:

| Case | Result |
| --- | --- |
| Edit the first message of a 3-turn chat | surface + request = only the edited message |
| `A → B → C`, edit `B` | request = `A, respA, X`; `C` gone |
| Edit the last message | prefix kept, last turn replaced |
| Edit the 4th of 6 turns | request = `m1…m3` + edit; `m4…m6` gone |
| Edit an already-edited message (nested) | previous edit's answer also gone |
| Cancel | conversation byte-identical |
| Edit while a response streams | running turn cancelled, edit applied, regenerated |
| System prompt / model selector / streaming / markdown | unchanged in every request |
| Message with an image attachment | non-text blocks preserved, text replaced |
| Reload (page and harness restart) | truncated turns stay gone; state rebuilt from the log |
| Identical text | no-op, no request |
| Empty text | refused |
| Unknown / stale message id | refused |

---

## Layout

```
index.js              host half: edit engine, Agent step hook, routes
client.js             client half: pencil, inline editor, edited-message node, transcript hiding
cordis.patch.yml      bundle patch (insert row)
bin/                  installer CLI
tools/mock-llm.mjs    recording OpenAI-completions stub used by the verification runs
```

## License

MIT
