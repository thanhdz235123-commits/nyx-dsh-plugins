/**
 * dsh-file-panel — host half.
 *
 * Serves the small read/write surface behind the in-app file panel:
 * file content, directory listings, session-recorded edit diffs, a git
 * fallback diff, and a guarded atomic write used by the panel's editor.
 *
 * Every route lives under a named `/api/dsh-file-panel.*` exact Fetch route on
 * the connection service, so it inherits the browser-session auth fence.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createReadStream, existsSync, readdirSync, promises as fsp } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'dsh-file-panel'
/** Bumped per host revision; the health route reports it so a reload is provable. */
export const BUILD = '0.6.3'
export const inject = ['connection']

const ROUTE_FILE = '/api/dsh-file-panel.file'
const ROUTE_TREE = '/api/dsh-file-panel.tree'
const ROUTE_CHANGES = '/api/dsh-file-panel.changes'
const ROUTE_DIFF = '/api/dsh-file-panel.diff'
const ROUTE_STAT = '/api/dsh-file-panel.stat'
const ROUTE_DIAG = '/api/dsh-file-panel.diag'
const ROUTE_WRITE = '/api/dsh-file-panel.write'
const ROUTE_HEALTH = '/api/dsh-file-panel.health'
const ROUTE_PROBE = '/api/dsh-file-panel.probe'
const ROUTE_RAW = '/api/dsh-file-panel.raw'
const ROUTE_SEARCH = '/api/dsh-file-panel.search'
const ROUTE_REVERT = '/api/dsh-file-panel.revert'
const ROUTE_RESOLVE = '/api/dsh-file-panel.resolve'
const ROUTE_REFERENCES = '/api/dsh-file-panel.references'
const ROUTE_LOCATE = '/api/dsh-file-panel.locate'

const MAX_INLINE_BYTES = 1_500_000
const MAX_RAW_BYTES = 12 * 1024 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_WALK_DIRECTORIES = 5000
const SEARCH_TIMEOUT_MS = 8000

/** Content types the panel can render directly (artifacts: screenshots, PDFs). */
const CONTENT_TYPE_BY_EXTENSION = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.wav': 'audio/wav', '.webm': 'video/webm'
}

/** Resolved ripgrep binary (undefined = not probed yet, null = unavailable). */
let ripgrepResolved

/** Directories a workspace walk never descends into. */
const WALK_SKIP = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.output', '.parcel-cache', '.turbo',
  '.venv', '.idea', '.vscode-test', '__pycache__', 'bin', 'build', 'coverage', 'dist',
  'node_modules', 'obj', 'out', 'target', 'tmp', 'vendor'
])
const MAX_TREE_ENTRIES = 4000
const GIT_TIMEOUT_MS = 8000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

const LANGUAGE_BY_EXTENSION = {
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.css': 'css', '.dart': 'dart', '.diff': 'diff', '.dockerfile': 'dockerfile',
  '.env': 'ini', '.ex': 'elixir', '.exs': 'elixir', '.go': 'go', '.gql': 'graphql',
  '.graphql': 'graphql', '.hbs': 'handlebars', '.html': 'html', '.ini': 'ini', '.java': 'java',
  '.js': 'javascript', '.json': 'json', '.json5': 'json5', '.jsonc': 'jsonc', '.jsx': 'jsx',
  '.kt': 'kotlin', '.kts': 'kotlin', '.less': 'less', '.lua': 'lua', '.md': 'markdown',
  '.mdx': 'mdx', '.mjs': 'javascript', '.mm': 'objective-c', '.nginx': 'nginx', '.patch': 'diff',
  '.php': 'php', '.pl': 'perl', '.properties': 'ini', '.proto': 'proto', '.ps1': 'powershell',
  '.py': 'python', '.pyi': 'python', '.rb': 'ruby', '.rs': 'rust', '.sass': 'sass', '.scala': 'scala',
  '.scss': 'scss', '.sh': 'shellscript', '.sql': 'sql', '.svelte': 'svelte', '.svg': 'xml',
  '.swift': 'swift', '.tf': 'hcl', '.toml': 'toml', '.ts': 'typescript', '.tsx': 'tsx',
  '.txt': 'text', '.vue': 'vue', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.zsh': 'shellscript'
}

const LANGUAGE_BY_BASENAME = {
  '.babelrc': 'json', '.dockerignore': 'dockerfile', '.editorconfig': 'ini', '.env': 'ini',
  '.gitignore': 'dockerfile', '.npmrc': 'ini', '.prettierrc': 'json', 'CMakeLists.txt': 'cmake',
  'Dockerfile': 'dockerfile', 'Gemfile': 'ruby', 'Makefile': 'makefile', 'Procfile': 'shellscript',
  'Rakefile': 'ruby', 'dockerfile': 'dockerfile', 'makefile': 'makefile'
}

/** @param {unknown} message */
function fail(code, message, status = 400) {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

/** @param {unknown} value */
function ok(value) {
  return Response.json({ ok: true, value })
}

/** @param {unknown} error */
function failure(error, fallbackCode = 'internal') {
  const code = typeof error?.code === 'string' ? error.code : fallbackCode
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'not-found' || code === 'ENOENT') return fail('not-found', message, 404)
  if (code === 'bad-request') return fail('bad-request', message, 400)
  if (code === 'forbidden') return fail('forbidden', message, 403)
  if (code === 'stale') return fail('stale', message, 409)
  if (code === 'too-large') return fail('too-large', message, 413)
  return fail(fallbackCode, message, 500)
}

/** @param {string} code @param {string} message */
function failure2(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @param {string} value */
function sha256OfBuffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** @param {string} filePath */
async function sha256OfFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** @param {Buffer} buffer */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192)
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true
  return false
}

/** @param {string} filePath */
function languageOf(filePath) {
  const base = path.basename(filePath)
  if (LANGUAGE_BY_BASENAME[base] !== undefined) return LANGUAGE_BY_BASENAME[base]
  const extension = path.extname(base).toLowerCase()
  return LANGUAGE_BY_EXTENSION[extension] ?? 'text'
}

/**
 * Resolve a caller-supplied path against the session workspace root.
 * `~` is the caller's home directory on every platform — a path written in a
 * message often is home-relative, and reading it as a workspace-relative name
 * would point at a file that only looks similar. Nothing here searches: the
 * result is the one path that was asked for, or an error.
 * @param {string | null} raw @param {string | null} cwd
 */
function resolveRequestPath(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0) throw failure2('bad-request', 'path is required')
  if (raw.includes('\u0000')) throw failure2('bad-request', 'path contains a NUL byte')
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? path.join(os.homedir(), raw.slice(1))
    : raw
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded))
}

/** @param {string} absolute @param {string | null} cwd */
function displayPathOf(absolute, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return absolute
  const relative = path.relative(cwd, absolute)
  if (relative === '') return '.'
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolute
  return relative
}

/**
 * Workspace-relative label resolved on canonical spellings, so a session log
 * that recorded `/private/tmp/...` and a caller that passed `/tmp/...` still
 * agree.
 * @param {string | null} cwd @param {string} absolute
 */
async function relativeTo(cwd, absolute) {
  if (typeof cwd !== 'string' || cwd.length === 0) return absolute
  const [canonicalCwd, canonicalAbsolute] = await Promise.all([canonicalize(cwd), canonicalize(absolute)])
  return displayPathOf(canonicalAbsolute, canonicalCwd)
}

/** @param {string | null} cwd */
function isInside(cwd, absolute) {
  if (typeof cwd !== 'string' || cwd.length === 0) return true
  const relative = path.relative(path.normalize(cwd), absolute)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** @param {string} content */
function countLines(content) {
  if (content === '') return []
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
  return normalized.split('\n')
}

/** One hunk as the client diff card expects it. */
function hunkTotals(hunks) {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    if (hunk.oldText !== null && hunk.oldText !== undefined) removed += countLines(hunk.oldText).length
    added += countLines(hunk.newText ?? '').length
  }
  return { added, removed }
}

// ---------------------------------------------------------------------------
// Session edit history
// ---------------------------------------------------------------------------

/**
 * Canonical spelling of a path (`/tmp` and `/private/tmp` are the same file on
 * macOS, and a session log records its own spelling — compare canonically).
 * @param {string} filePath
 */
async function canonicalize(filePath) {
  let current = path.normalize(filePath)
  const missing = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fsp.realpath(current)
      return missing.length === 0 ? real : path.join(real, ...missing)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) break
      missing.unshift(path.basename(current))
      current = parent
    }
  }
  return path.normalize(filePath)
}

/** @param {string} a @param {string} b */
function samePath(a, b) {
  return a === b || path.normalize(a) === path.normalize(b)
}

/**
 * Live per-session diff state: `{ index, lastSeq, frames, bytes, truncated }`.
 * Seeded once from a whole-log read, then kept current by the session event
 * stream, so a panel read never re-decodes a multi-megabyte log.
 */
const liveIndexes = new Map()
const MAX_LIVE_SESSIONS = 64
let liveSubscription = false
/** Sessions the query service refused (a torn frame fails its whole-log validation). */
const queryRefusalCache = new Map()
const QUERY_REFUSAL_TTL_MS = 30_000
/** The window a cold look walks back from the end of a big log. */
const TAIL_WINDOW_BYTES = 1024 * 1024
/** Frames a cold look keeps: enough to paint, few enough to be a blink. */
const COLD_TAIL_FRAMES = 1200
/** Above this, a range is worth handing to the `zstd` binary. */
const CLI_READ_MIN_BYTES = 512 * 1024
/** Milliseconds the background crawl rests between batches, so a 200k-frame log
 *  does not hold a core while the reader is doing something else. */
const CRAWL_PAUSE_MS = 3
/** Newest frames decoded per cold read: a 200k-frame log costs ~10 ms per 100 frames. */
const MAX_LOG_TAIL_FRAMES = 6000
/** A log this small is read whole on the spot: accuracy beats a checkpoint. */
const SYNC_FULL_READ_BYTES = 2 * 1024 * 1024
/** Where a session's diff-index checkpoint is kept, and how big it may get. */
const INDEX_CACHE_DIR = 'dsh-file-panel-index'
const INDEX_CACHE_VERSION = 1
const MAX_INDEX_CACHE_BYTES = 4 * 1024 * 1024
/** Sessions whose partial index is being finished off the click path. */
const indexCrawls = new Set()
const FOLD_BATCH_FRAMES = 128

/** Zstandard frame magic (RFC 8878 frames are concatenated in a session log). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Walk one Zstandard frame's header and block headers to find its exact end.
 * Block headers carry the compressed size, so boundaries are found without
 * decompressing — the only reliable way to split a concatenated log (the magic
 * byte pattern can also occur inside compressed data).
 * @param {Buffer} buffer @param {number} start
 * @returns {number | null} end offset, or null for a torn/invalid frame
 */
function zstdFrameEnd(buffer, start) {
  if (buffer.length < start + 5) return null
  if (buffer.compare(ZSTD_MAGIC, 0, 4, start, start + 4) !== 0) return null
  let cursor = start + 4
  const descriptor = buffer[cursor]
  cursor += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (singleSegment === 0) cursor += 1
  cursor += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4
  if (contentSizeFlag === 0) {
    if (singleSegment === 1) cursor += 1
  } else if (contentSizeFlag === 1) cursor += 2
  else if (contentSizeFlag === 2) cursor += 4
  else cursor += 8
  for (;;) {
    if (cursor + 3 > buffer.length) return null
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >> 3
    if (blockType === 3) return null
    cursor += blockType === 1 ? 1 : blockSize
    if (cursor > buffer.length) return null
    if (lastBlock === 1) break
  }
  if (checksum === 1) cursor += 4
  return cursor <= buffer.length ? cursor : null
}

/**
 * Frame boundaries of a concatenated log inside `buffer`.
 * @param {Buffer} buffer @param {number} from
 * @returns {{ slices: Array<[number, number]>, truncated: boolean }}
 */
function zstdFrameSlices(buffer, from) {
  const slices = []
  let cursor = from
  let truncated = false
  while (cursor + 4 <= buffer.length) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, cursor, cursor + 4) !== 0) {
      const next = buffer.indexOf(ZSTD_MAGIC, cursor + 1)
      if (next === -1) break
      cursor = next
      continue
    }
    const end = zstdFrameEnd(buffer, cursor)
    if (end === null) {
      truncated = true
      break
    }
    slices.push([cursor, end])
    cursor = end
  }
  return { slices, truncated }
}

/**
 * Frame boundaries with the event loop yielded every batch — the cold read of a
 * 200k-frame log must not stall the harness while it walks.
 * @param {Buffer} buffer @param {number} from @param {number} batch
 */
async function zstdFrameSlicesAsync(buffer, from, batch = 2048) {
  const slices = []
  let cursor = from
  let truncated = false
  while (cursor + 4 <= buffer.length) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, cursor, cursor + 4) !== 0) {
      const next = buffer.indexOf(ZSTD_MAGIC, cursor + 1)
      if (next === -1) break
      cursor = next
      continue
    }
    const end = zstdFrameEnd(buffer, cursor)
    if (end === null) {
      truncated = true
      break
    }
    slices.push([cursor, end])
    cursor = end
    if (slices.length % batch === 0) await new Promise((resolve) => setImmediate(resolve))
  }
  return { slices, truncated }
}

/**
 * Decode a whole concatenated log. Kept for the probe route and small reads.
 * @param {Buffer} buffer @param {number} startOffset
 * @returns {{ text: string, frames: number, truncated: boolean }}
 */
function decodeZstdFrames(buffer, startOffset = 0) {
  if (typeof zlib.zstdDecompressSync !== 'function') return { text: buffer.toString('utf8'), frames: 0, truncated: false }
  const { slices, truncated } = zstdFrameSlices(buffer, startOffset)
  const chunks = []
  for (const [from, to] of slices) {
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(from, to)).toString('utf8'))
    } catch {
      // one unreadable frame must not discard the rest of the log
    }
  }
  return { text: chunks.join(''), frames: slices.length, truncated }
}

/**
 * Fold decoded JSONL records into a path -> hunks index. Only tool results that
 * carry `meta.diffs` matter, and the substring reject keeps a 200k-record log
 * from paying JSON.parse for every streaming chunk.
 * @param {string} text @param {Map<string, {path: string, hunks: unknown[], added: number, removed: number, time: number | null}>} index
 */
function foldDiffEvent(event, state) {
  if (event?.type !== 'tool/result') return 0
  // Folding is idempotent: the live event stream and a catch-up pass can hand the
  // same event over twice, and a hunk counted twice would be a lie.
  if (typeof event.seq === 'number' && state.lastSeq !== null && event.seq <= state.lastSeq) return 0
  const diffs = event?.data?.meta?.diffs
  if (!Array.isArray(diffs)) return 0
  const index = state.index
  let folded = 0
  for (const diff of diffs) {
    if (typeof diff?.path !== 'string') continue
    const key = path.normalize(diff.path)
    const record = index.get(key) ?? { path: key, hunks: [], added: 0, removed: 0, time: null }
    const hunk = {
      oldText: typeof diff.oldText === 'string' ? diff.oldText : null,
      newText: typeof diff.newText === 'string' ? diff.newText : ''
    }
    const totals = hunkTotals([hunk])
    record.hunks.push(hunk)
    record.added += totals.added
    record.removed += totals.removed
    if (typeof event.time === 'number' && (record.time === null || event.time > record.time)) record.time = event.time
    index.set(key, record)
    folded += 1
  }
  if (typeof event.seq === 'number' && (state.lastSeq === null || event.seq > state.lastSeq)) state.lastSeq = event.seq
  return folded
}

/**
 * Fold decoded JSONL records into a path -> hunks index. Only tool results that
 * carry `meta.diffs` matter, and the substring reject keeps a 200k-record log
 * from paying JSON.parse for every streaming chunk.
 * @param {string} text @param {{index: Map<string, unknown>, lastSeq: number | null}} state
 */
function foldDiffRecords(text, state) {
  let folded = 0
  for (const line of text.split('\n')) {
    // The cheap reject comes first, on the raw line: a cold read is millions of
    // streaming chunks, and trimming each one before rejecting it was most of a
    // whole-log scan's cost.
    if (line.indexOf('"diffs"') === -1) continue
    if (line.length < 24 || line.indexOf('"meta"') === -1) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    folded += foldDiffEvent(event, state)
  }
  return folded
}

/**
 * @param {string} sessionId
 * @returns {Promise<{path: string, size: number, mtimeMs: number} | null>}
 */
async function locateSessionLog(sessionId) {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) return null
  const root = path.join(home, 'sessions')
  let groups
  try {
    groups = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
      if (name.endsWith('.zstd') && typeof zlib.zstdDecompressSync !== 'function') continue
      const candidate = path.join(root, group.name, sessionId, name)
      const stats = await fsp.stat(candidate).catch(() => null)
      if (stats === null) continue
      return { path: candidate, size: stats.size, mtimeMs: stats.mtimeMs }
    }
  }
  return null
}

/**
 * Build (or incrementally extend) one session's diff index from its persisted
 * log. A DSH log is append-only: after the first read only the new frames are
 * decoded, and frames are folded in batches with the event loop yielded between
 * them so a multi-megabyte tail never blocks the harness.
 * @param {string} sessionId
 * @returns {Promise<{index: Map<string, unknown>, frames: number, bytes: number, truncated: boolean, source: string} | null>}
 */
/** Subscribe once to the session event stream; new diffs land in the live indexes. */
function installLiveIndex() {
  if (liveSubscription) return
  liveSubscription = true
  const ctx = liveIndexContext
  if (ctx === undefined) return
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'tool/result') return
    const state = liveIndexes.get(session?.id)
    if (state === undefined) return
    if (typeof event.seq === 'number' && state.lastSeq !== null && event.seq <= state.lastSeq) return
    foldDiffEvent(event, state)
  })
}

let liveIndexContext

/**
 * Adopt a freshly seeded index as the session's live state.
 * @param {string} sessionId @param {{index: Map<string, unknown>, lastSeq: number | null, frames: number, bytes: number, truncated: boolean}} state
 */
function adoptLiveIndex(sessionId, state) {
  if (liveIndexes.size >= MAX_LIVE_SESSIONS) {
    const oldest = liveIndexes.keys().next()
    if (oldest.done !== true) liveIndexes.delete(oldest.value)
  }
  liveIndexes.set(sessionId, state)
  return state
}

async function diffIndexForSession(sessionId, options = {}) {
  const located = await locateSessionLog(sessionId)
  if (located === null) return null
  const state = {
    index: new Map(),
    lastSeq: null,
    frames: 0,
    bytes: located.size,
    truncated: false,
    source: 'log',
    complete: false
  }
  // A log small enough to read whole is read whole: accuracy first, and a few
  // hundred kilobytes of frames is not worth a checkpoint.
  const whole = options.whole === true || located.size <= SYNC_FULL_READ_BYTES
  const pace = options.pace === true
  const cli = options.cli !== false
  const cache = whole ? null : await readIndexCache(sessionId)

  let start = 0
  let plan = { cap: Infinity, keepNewest: false, pace, cli }
  let pass
  const seededFromCache = cache !== null && cache.offset > 0 && cache.offset <= located.size
  if (seededFromCache) {
    // Continue where the last scan stopped: the frames appended since then are
    // the only ones that need decoding, which is what makes a revisit a blink.
    state.index = seedIndexFromFiles(cache.files)
    state.lastSeq = typeof cache.lastSeq === 'number' ? cache.lastSeq : null
    start = cache.offset
    plan = { cap: MAX_LOG_TAIL_FRAMES, keepNewest: false, pace, cli }
    pass = await foldLogRange(state, located.path, start, located.size, plan)
  } else if (!whole) {
    // First look at a log too big to read under a reader's finger: the newest
    // window of it, and only its newest frames — the way a reader scrolls to the
    // bottom. The window is what keeps the frame-boundary walk short; the rest is
    // folded off the click path, and then remembered.
    plan = { cap: COLD_TAIL_FRAMES, keepNewest: true, pace, cli: false }
    let window = Math.min(located.size, TAIL_WINDOW_BYTES)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      start = Math.max(0, located.size - window)
      pass = await foldLogRange(state, located.path, start, located.size, plan)
      if (start === 0 || pass.frames >= plan.cap) break
      window = Math.min(located.size, window * 4)
    }
  } else {
    pass = await foldLogRange(state, located.path, 0, located.size, plan)
  }
  // Only a pass that began at the start of the log (or continued a checkpoint)
  // and reached its end may claim to be complete — and only a complete pass is
  // worth remembering.
  state.complete = pass.end >= located.size && (pass.start === 0 || seededFromCache)
  state.truncated = state.complete !== true
  if (state.complete) await writeIndexCache(sessionId, state, located.size)
  return state
}


/**
 * The `zstd` binary, when this machine has one. A whole-log read through it is
 * one native pass — a second or two on a log that costs half a minute read frame
 * by frame through the Node API.
 * @returns {string | null}
 */
let zstdCli
let zstdCliChecked = false
function zstdBinary() {
  if (zstdCliChecked) return zstdCli
  zstdCliChecked = true
  for (const candidate of ['/usr/local/bin/zstd', '/opt/homebrew/bin/zstd', '/usr/bin/zstd', 'zstd']) {
    if (candidate === 'zstd' || existsSync(candidate)) {
      zstdCli = candidate
      break
    }
  }
  return zstdCli
}

/**
 * Fold a byte range by letting the `zstd` binary decode it, streamed into the
 * same line scan the frame-by-frame path uses. Concatenated frames are what a
 * session log is, and the binary walks them natively.
 * @returns {Promise<{start: number, end: number, frames: number} | null>} null
 *   when there is nothing to run, so the caller falls back to Node's decoder.
 */
async function foldLogRangeViaCli(state, filePath, start, end) {
  const binary = zstdBinary()
  if (binary === null || end <= start) return null
  const child = spawn(binary, ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const source = createReadStream(filePath, { start, end })
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (chunk) => {
    const text = pending + decoder.write(chunk)
    const cut = text.lastIndexOf('\n')
    if (cut < 0) {
      pending = text
      return
    }
    foldDiffRecords(text.slice(0, cut), state)
    pending = text.slice(cut + 1)
  }
  child.stdout.on('data', consume)
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('error', () => resolve())
    child.on('close', (code) => (code === 0 || code === null ? resolve() : reject(new Error(`zstd exited ${code}`))))
    source.on('error', reject)
  })
  source.pipe(child.stdin)
  try {
    await done
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    return null
  }
  foldDiffRecords(pending + decoder.end(), state)
  return { start, end, frames: 0 }
}

/**
 * Fold every zstd frame of `[start, end)` into `state`, yielding to the event
 * loop between batches so a cold read never stalls the harness.
 * @param {any} state @param {string} filePath @param {number} start @param {number} end
 * @param {{cap: number, keepNewest: boolean}} plan
 * @returns {Promise<{start: number, end: number}>} the file offsets of the first
 *   frame folded and the end of the last one, so the caller can tell a pass that
 *   covered the log from one that only sampled its tail.
 */
async function foldLogRange(state, filePath, start, end, plan) {
  const length = end - start
  if (length <= 0) return { start, end: start, frames: 0 }
  // A range big enough to matter goes through the binary: one native pass beats
  // a decompression call per frame by an order of magnitude.
  if (plan.cli === true && length >= CLI_READ_MIN_BYTES) {
    const viaCli = await foldLogRangeViaCli(state, filePath, start, end)
    if (viaCli !== null) return viaCli
  }
  const handle = await fsp.open(filePath, 'r')
  try {
    let buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    buffer = buffer.subarray(0, bytesRead)
    let base = start
    if (start > 0) {
      const align = buffer.indexOf(ZSTD_MAGIC)
      if (align === -1) return { start, end: start, frames: 0 }
      if (align > 0) {
        buffer = buffer.subarray(align)
        base = start + align
      }
    }
    const walkStarted = Date.now()
    const walked = await zstdFrameSlicesAsync(buffer, 0)
    state.walkMs = (state.walkMs ?? 0) + (Date.now() - walkStarted)
    if (walked.truncated) state.truncated = true
    let slices = walked.slices
    if (plan.cap !== Infinity && slices.length > plan.cap) {
      slices = plan.keepNewest === true ? slices.slice(-plan.cap) : slices.slice(0, plan.cap)
    }
    state.frames += slices.length
    const foldStarted = Date.now()
    let pending = ''
    for (let offset = 0; offset < slices.length; offset += 1) {
      const [from, to] = slices[offset]
      try {
        pending += zlib.zstdDecompressSync(buffer.subarray(from, to)).toString('utf8')
      } catch {
        // skip an unreadable frame
      }
      if (offset % FOLD_BATCH_FRAMES === FOLD_BATCH_FRAMES - 1) {
        foldDiffRecords(pending, state)
        pending = ''
        await new Promise((resolve) => (plan.pace === true ? setTimeout(resolve, CRAWL_PAUSE_MS) : setImmediate(resolve)))
      }
    }
    foldDiffRecords(pending, state)
    state.foldMs = (state.foldMs ?? 0) + (Date.now() - foldStarted)
    if (slices.length === 0) return { start: base, end: base, frames: 0 }
    return { start: base + slices[0][0], end: base + slices[slices.length - 1][1], frames: slices.length }
  } finally {
    await handle.close()
  }
}

/** Where a session's diff-index checkpoint lives. */
function indexCacheFile(sessionId) {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) return null
  return path.join(home, INDEX_CACHE_DIR, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

/** The last completed scan of one session, or null. */
async function readIndexCache(sessionId) {
  const file = indexCacheFile(sessionId)
  if (file === null) return null
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (parsed?.version !== INDEX_CACHE_VERSION) return null
    if (typeof parsed.offset !== 'number' || Array.isArray(parsed.files) !== true) return null
    return parsed
  } catch {
    return null
  }
}

/** Remember a complete scan, so the next look only reads what is new. */
async function writeIndexCache(sessionId, state, offset) {
  const file = indexCacheFile(sessionId)
  if (file === null) return false
  const payload = JSON.stringify({
    version: INDEX_CACHE_VERSION,
    offset,
    lastSeq: state.lastSeq ?? null,
    files: [...state.index.values()]
  })
  if (Buffer.byteLength(payload) > MAX_INDEX_CACHE_BYTES) return false
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, payload)
    await fsp.rename(tmp, file)
    return true
  } catch {
    return false
  }
}

/** @param {unknown[]} files */
function seedIndexFromFiles(files) {
  const index = new Map()
  for (const entry of Array.isArray(files) ? files : []) {
    if (typeof entry?.path !== 'string') continue
    const key = path.normalize(entry.path)
    index.set(key, {
      path: key,
      hunks: Array.isArray(entry.hunks) ? entry.hunks : [],
      added: typeof entry.added === 'number' ? entry.added : 0,
      removed: typeof entry.removed === 'number' ? entry.removed : 0,
      time: typeof entry.time === 'number' ? entry.time : null
    })
  }
  return index
}

/**
 * A partial seed finishes itself off the click path: the panel already has an
 * answer, and the complete index (plus its checkpoint) lands behind it.
 */
async function finishIndexInBackground(sessionId) {
  if (indexCrawls.has(sessionId)) return
  indexCrawls.add(sessionId)
  const startedAt = Date.now()
  try {
    for (let pass = 0; pass < 64; pass += 1) {
      const state = await diffIndexForSession(sessionId, { whole: true, pace: true })
      if (state === null || state.complete === true) {
        if (state !== null) {
          liveIndexes.set(sessionId, state)
          // Close the gap between the crawl's last read and this swap: whatever
          // the log gained meanwhile is one checkpoint away.
          const settled = await diffIndexForSession(sessionId).catch(() => null)
          if (settled !== null) liveIndexes.set(sessionId, settled)
          void appendPanelDiag({
            reason: 'crawl',
            sessionId: sessionId.slice(0, 48),
            ms: Date.now() - startedAt,
            walkMs: state.walkMs ?? 0,
            foldMs: state.foldMs ?? 0,
            frames: state.frames,
            files: state.index.size,
            bytes: state.bytes
          })
        }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch {
    /* a background crawl never reports */
  } finally {
    indexCrawls.delete(sessionId)
  }
}

/**
 * Diff index for a session. Seeded once from the whole log (the harness query
 * service first: one complete pass; the frame-capped local reader for sessions
 * the query service refuses) and kept current afterwards by the session event
 * stream, so panel reads are O(1) instead of a 5-second whole-log scan.
 * @param {unknown} ctx @param {string} sessionId @param {{fresh?: boolean}} options
 */
async function sessionDiffIndex(ctx, sessionId, options = {}) {
  const empty = { index: new Map(), frames: 0, bytes: 0, truncated: false, source: 'none', live: false }
  if (typeof sessionId !== 'string' || sessionId.length === 0) return empty
  liveIndexContext = ctx
  installLiveIndex()

  const existing = liveIndexes.get(sessionId)
  if (existing !== undefined && options.fresh !== true) {
    return { index: existing.index, frames: existing.frames, bytes: existing.bytes, truncated: existing.truncated, source: existing.source, live: true }
  }

  const state = { index: new Map(), lastSeq: null, frames: 0, bytes: 0, truncated: false, source: 'none', complete: false }
  // The log on disk is the whole truth, and with its checkpoint only the frames
  // appended since the last look need decoding — so it is read first, not the
  // whole-log query pass that made a cold click wait tens of seconds.
  const fromLog = await diffIndexForSession(sessionId).catch(() => null)
  if (fromLog !== null) {
    Object.assign(state, fromLog)
    state.source = 'log'
  }
  if (state.source === 'none') {
    // No readable log for this session: the query service is the only way in.
    const refusedAt = queryRefusalCache.get(sessionId)
    if (refusedAt === undefined || Date.now() - refusedAt >= QUERY_REFUSAL_TTL_MS) {
      const events = await loadSessionEventsFromQuery(ctx, sessionId, () => queryRefusalCache.set(sessionId, Date.now()))
      if (events.length > 0) {
        for (const event of events) foldDiffEvent(event, state)
        state.source = 'query'
      }
    }
  }
  adoptLiveIndex(sessionId, state)
  // A seed that did not reach the start of the log finishes itself while the
  // reader is already looking at what the newest frames had to say.
  if (fromLog !== null && fromLog.complete !== true) void finishIndexInBackground(sessionId)
  return { index: state.index, frames: state.frames, bytes: state.bytes, truncated: state.truncated, source: state.source, live: false }
}

/**
 * Read a session's complete event log through the harness query service.
 * @param {unknown} ctx @param {string} sessionId
 * @returns {Promise<unknown[]>}
 */
async function loadSessionEventsFromQuery(ctx, sessionId, onRefusal) {
  const query = ctx.get('sessionQuery')
  if (query?.readSession === undefined) return []
  try {
    const loaded = await query.readSession(sessionId)
    const events = loaded?.events ?? loaded?.session?.events ?? loaded?.log?.events
    return Array.isArray(events) ? events : []
  } catch {
    onRefusal?.()
    return []
  }
}

/**
 * Aggregate session-recorded hunks by path (the query-service shape).
 * @param {unknown[]} events
 */
function sessionChangedFiles(events) {
  const index = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const diffs = event?.data?.meta?.diffs
    if (!Array.isArray(diffs)) continue
    for (const diff of diffs) {
      if (typeof diff?.path !== 'string') continue
      const key = path.normalize(diff.path)
      const record = index.get(key) ?? { path: key, hunks: [], added: 0, removed: 0, time: null }
      const hunk = {
        oldText: typeof diff.oldText === 'string' ? diff.oldText : null,
        newText: typeof diff.newText === 'string' ? diff.newText : ''
      }
      const totals = hunkTotals([hunk])
      record.hunks.push(hunk)
      record.added += totals.added
      record.removed += totals.removed
      if (typeof event.time === 'number' && (record.time === null || event.time > record.time)) record.time = event.time
      index.set(key, record)
    }
  }
  return [...index.values()]
}

/**
 * Find one path's entry in a diff index, matching canonical spellings so a log
 * that recorded `/private/...` still answers for `/tmp/...`.
 * @param {Map<string, any>} index @param {string} absolutePath
 */
async function indexEntryForPath(index, absolutePath) {
  const direct = index.get(path.normalize(absolutePath))
  if (direct !== undefined) return direct
  const target = await canonicalize(absolutePath)
  for (const [key, record] of index) {
    const canonical = await canonicalize(key)
    if (canonical === target || samePath(canonical, target)) return record
  }
  return null
}

/** @param {string} logPath */
async function readSessionLog(logPath) {
  const raw = await fsp.readFile(logPath)
  const text = logPath.endsWith('.zstd') ? decodeZstdFrames(raw).text : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // a torn tail line is not fatal
    }
  }
  return events
}

/** @param {string} workdir @param {string[]} args */
function runGit(workdir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', workdir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    })
  })
}

/** @param {string} workdir */
async function gitRepoInfo(workdir) {
  const inside = await runGit(workdir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return { available: false }
  const root = (await runGit(workdir, ['rev-parse', '--show-toplevel'])).stdout.trim()
  const branch = (await runGit(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  return { available: root.length > 0, root, branch }
}

/**
 * Parse a unified diff into the panel's per-hunk shape.
 * @param {string} patchText
 */
function parseUnifiedHunks(patchText) {
  const hunks = []
  let current = null
  const flush = () => {
    if (current === null) return
    if (current.oldLines.length > 0 || current.newLines.length > 0) {
      hunks.push({
        oldText: current.oldLines.length > 0 ? current.oldLines.join('\n') : null,
        newText: current.newLines.join('\n')
      })
    }
    current = null
  }
  for (const line of patchText.split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      current = { oldLines: [], newLines: [] }
      continue
    }
    if (current === null) continue
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('-')) current.oldLines.push(line.slice(1))
    else if (line.startsWith('+')) current.newLines.push(line.slice(1))
    else if (line.startsWith(' ')) {
      current.oldLines.push(line.slice(1))
      current.newLines.push(line.slice(1))
    }
  }
  flush()
  return hunks
}

/** @param {string} workdir @param {string} absolutePath */
async function gitHunksForPath(workdir, absolutePath) {
  const info = await gitRepoInfo(workdir)
  if (!info.available) return { available: false, hunks: [] }
  const target = await canonicalize(absolutePath)
  const root = await canonicalize(info.root)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { available: true, root: info.root, hunks: [], outside: true }
  const patch = await runGit(root, ['diff', '--no-color', '-U3', 'HEAD', '--', relative])
  if (patch.stdout.trim().length > 0) {
    return { available: true, root: info.root, branch: info.branch, hunks: parseUnifiedHunks(patch.stdout) }
  }
  const untracked = await runGit(info.root, ['ls-files', '--others', '--exclude-standard', '--', relative])
  if (untracked.stdout.trim().length > 0) {
    const content = await fsp.readFile(absolutePath, 'utf8').catch(() => '')
    return { available: true, root: info.root, branch: info.branch, untracked: true, hunks: [{ oldText: null, newText: content }] }
  }
  return { available: true, root: info.root, branch: info.branch, hunks: [] }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** @param {string} absolute @param {number} maxBytes */
async function readFilePayload(absolute, maxBytes) {
  const stats = await fsp.stat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') throw failure2('not-found', `no such file: ${absolute}`)
    throw error
  })
  if (stats.isDirectory()) throw failure2('bad-request', `${absolute} is a directory`)
  if (!stats.isFile()) throw failure2('bad-request', `${absolute} is not a regular file`)
  const truncated = stats.size > maxBytes
  let buffer
  if (truncated) {
    const handle = await fsp.open(absolute, 'r')
    try {
      buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      buffer = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } else {
    buffer = await fsp.readFile(absolute)
  }
  const binary = looksBinary(buffer)
  return {
    path: absolute,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    truncated,
    binary,
    content: binary ? '' : buffer.toString('utf8'),
    sha256: await sha256OfFile(absolute),
    lang: languageOf(absolute),
    lines: binary ? 0 : countLines(buffer.toString('utf8')).length
  }
}

/** @param {Request} request @param {unknown[]} events */
async function handleFile(request, ctx) {
  const url = new URL(request.url)
  const cwd = url.searchParams.get('cwd')
  const absolute = resolveRequestPath(url.searchParams.get('path'), cwd)
  const maxBytes = Number(url.searchParams.get('maxBytes') ?? MAX_INLINE_BYTES)
  const payload = await readFilePayload(absolute, Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_INLINE_BYTES)
  const repo = await gitRepoInfo(typeof cwd === 'string' && cwd.length > 0 ? cwd : path.dirname(absolute))
  return ok({ ...payload, canonicalPath: await canonicalize(absolute), relativePath: await relativeTo(cwd, absolute), repo })
}

/** @param {Request} request */
async function handleTree(request) {
  const url = new URL(request.url)
  const cwd = url.searchParams.get('cwd')
  const absolute = resolveRequestPath(url.searchParams.get('path') ?? cwd, cwd)
  const stats = await fsp.stat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') throw failure2('not-found', `no such directory: ${absolute}`)
    throw error
  })
  if (!stats.isDirectory()) throw failure2('bad-request', `${absolute} is not a directory`)
  const dirents = await fsp.readdir(absolute, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    if (dirent.name === '.DS_Store') continue
    const childPath = path.join(absolute, dirent.name)
    const child = await fsp.lstat(childPath).catch(() => null)
    const isDirectory = dirent.isDirectory() || (dirent.isSymbolicLink() && child?.isDirectory() === true)
    entries.push({
      name: dirent.name,
      path: childPath,
      type: isDirectory ? 'directory' : dirent.isFile() ? 'file' : 'other',
      size: child?.size ?? 0,
      mtimeMs: child?.mtimeMs ?? 0,
      symlink: dirent.isSymbolicLink()
    })
    if (entries.length >= MAX_TREE_ENTRIES) break
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return ok({ path: absolute, relativePath: await relativeTo(cwd, absolute), entries, truncated: entries.length >= MAX_TREE_ENTRIES })
}

/** @param {Request} request @param {import('@deepseek-ai/cordis').Context} ctx */
async function handleChanges(request, ctx) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  const cwd = url.searchParams.get('cwd')
  const { index, frames, bytes, truncated, source, live } = await sessionDiffIndex(ctx, sessionId ?? '')
  const withRelative = []
  for (const file of index.values()) {
    withRelative.push({
      ...file,
      canonicalPath: await canonicalize(file.path),
      relativePath: await relativeTo(cwd, file.path)
    })
  }
  withRelative.sort((left, right) => (right.time ?? 0) - (left.time ?? 0))
  return ok({ sessionId, source, frames, bytes, truncated, live: live === true, files: withRelative })
}

/** @param {Request} request @param {import('@deepseek-ai/cordis').Context} ctx */
async function handleDiff(request, ctx) {
  const url = new URL(request.url)
  const cwd = url.searchParams.get('cwd')
  const absolute = resolveRequestPath(url.searchParams.get('path'), cwd)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const want = url.searchParams.get('source') ?? 'auto'
  const diffSource = want === 'git' ? null : await sessionDiffIndex(ctx, sessionId)
  const entry = diffSource === null ? null : await indexEntryForPath(diffSource.index, absolute)
  const sessionHunks = entry === null ? [] : entry.hunks
  let git = null
  if (want !== 'session') {
    const workdir = typeof cwd === 'string' && cwd.length > 0 ? cwd : path.dirname(absolute)
    git = await gitHunksForPath(workdir, absolute)
  }
  const source = sessionHunks.length > 0 && want !== 'git'
    ? 'session'
    : git !== null && git.hunks.length > 0 ? 'git' : sessionHunks.length > 0 ? 'session' : 'none'
  const hunks = source === 'git' ? git.hunks : sessionHunks
  const totals = hunkTotals(hunks)
  return ok({
    path: absolute,
    canonicalPath: await canonicalize(absolute),
    relativePath: await relativeTo(cwd, absolute),
    source,
    hunks,
    added: totals.added,
    removed: totals.removed,
    sessionHunks: sessionHunks.length,
    sessionSource: diffSource?.source ?? 'none',
    sessionLive: diffSource?.live === true,
    sessionFrames: diffSource?.frames ?? 0,
    sessionScanTruncated: diffSource?.truncated ?? false,
    git: git === null ? null : { available: git.available, root: git.root ?? null, branch: git.branch ?? null, untracked: git.untracked ?? false, hunks: git.hunks.length }
  })
}

/**
 * Append one line to the panel's diag file, whoever is reporting: the client's
 * window geometry, or the host's own background work.
 * @param {object} record
 * @returns {Promise<string | null>} the file written, or null when there is none.
 */
async function appendPanelDiag(record) {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) return null
  const file = path.join(home, 'dsh-file-panel-diag.jsonl')
  const line = `${JSON.stringify({ ...record, receivedAt: new Date().toISOString() })}\n`
  await fsp.appendFile(file, line).catch(() => {})
  return file
}

/**
 * The panel's black box: the client reports what its window actually looks like
 * (build, mode, geometry, column widths) and it lands in a file next to the
 * harness home, so a report from any machine can be read instead of guessed at.
 * @param {Request} request
 */
async function handleDiag(request) {
  const body = await request.json().catch(() => null)
  const file = await appendPanelDiag(body ?? {})
  if (file === null) return ok({ written: false })
  const stats = await fsp.stat(file).catch(() => null)
  if (stats !== null && stats.size > 400000) {
    const kept = (await fsp.readFile(file, 'utf8').catch(() => '')).split('\n').slice(-200).join('\n')
    await fsp.writeFile(file, kept).catch(() => {})
  }
  return ok({ written: true, file })
}

/**
 * File tools whose call arguments name one openable path.
 *
 * This mirrors `deriveFilePath` in `@deepseek-ai/dsh-client-ui-tool` — the
 * mechanism that already made DSH's own file chips exact: the path comes from
 * the tool call's structured arguments, never from prose and never from
 * joining a name onto a directory.
 */
const FILE_PATH_TOOLS = new Set(['read', 'write', 'edit'])
const FILE_PATH_KEYS = ['path', 'file_path']

/** @type {Map<string, { count: number, paths: string[], source: string }>} */
const recordedPathCache = new Map()

/**
 * Every exact file path a session's file tools named, in call order.
 * @param events - the session's event log.
 * @returns the paths as recorded, deduplicated.
 */
function recordedPaths(events) {
  const paths = []
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (FILE_PATH_TOOLS.has(data.name) !== true) continue
    let parsed
    try {
      parsed = data.arguments === undefined || data.arguments === '' ? {} : JSON.parse(data.arguments)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    let picked
    for (const key of FILE_PATH_KEYS) {
      const value = parsed[key]
      if (typeof value === 'string' && value !== '') {
        picked = value
        break
      }
    }
    if (picked === undefined) continue
    const path = picked.split('\n')[0]
    if (path !== '' && paths.includes(path) !== true) paths.push(path)
  }
  return paths
}

/**
 * The paths this session's file tools named, for click resolution.
 *
 * A relative link is otherwise answered by joining the name onto the session
 * folder, which is a guess; the session's own record is not a guess. Same
 * source as DSH's own file chips.
 *
 * @param ctx - host plugin context.
 * @param request - GET /api/dsh-file-panel.references?sessionId=…
 */
async function sessionEventsFor(ctx, sessionId) {
  if (sessionId === '') return { events: [], source: 'none' }
  const live = liveSessionEvents(ctx, sessionId)
  if (live !== null) return { events: live, source: 'live' }
  const events = await loadSessionEventsFromQuery(ctx, sessionId)
  return { events, source: events.length > 0 ? 'query' : 'none' }
}

async function handleReferences(ctx, request) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') return ok({ paths: [], source: 'none' })

  // A click has to answer now. The live session is already in memory, so the
  // scan is a walk over its own event list; the durable query below is only for
  // a session this process does not hold (cold history, never the one being
  // read), and it can take tens of seconds on a large log.
  const live = liveSessionEvents(ctx, sessionId)
  const cached = recordedPathCache.get(sessionId)
  if (live !== null) {
    if (cached !== undefined && cached.count === live.length && cached.source === 'live') {
      return ok({ paths: cached.paths, source: 'cache' })
    }
    const paths = recordedPaths(live)
    recordedPathCache.set(sessionId, { count: live.length, paths, source: 'live' })
    return ok({ paths, source: 'live' })
  }

  const events = await loadSessionEventsFromQuery(ctx, sessionId)
  if (cached !== undefined && cached.count === events.length) return ok({ paths: cached.paths, source: 'cache' })
  const paths = recordedPaths(events)
  recordedPathCache.set(sessionId, { count: events.length, paths, source: 'query' })
  return ok({ paths, source: events.length > 0 ? 'query' : 'none' })
}

/**
 * Events of one live agent's session, read straight out of memory.
 * @param ctx - host plugin context.
 * @param sessionId - session to read.
 * @returns the event list, or null when this process does not hold the session.
 */
function liveSessionEvents(ctx, sessionId) {
  try {
    const session = ctx.get('agents')?.get?.(sessionId)?.session
    if (session === undefined || session === null) return null
    const events = session.ownEvents()
    return Array.isArray(events) ? events : null
  } catch {
    return null
  }
}

/** Does this absolute path exist right now? */
async function statOrNull(absolute) {
  try {
    const stats = await fsp.stat(absolute)
    return { path: absolute, size: stats.size, mtimeMs: stats.mtimeMs, isDirectory: stats.isDirectory() }
  } catch {
    return null
  }
}

/** Lexical comparison form: separators unified, `.` / `..` folded. */
function comparablePath(value) {
  const unified = String(value ?? '').replace(/\\/g, '/')
  const parts = []
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * The one place a click's token becomes a path.
 *
 * The panel does not guess: it asks here, and this answers with either a single
 * file the evidence supports, a short list of files that share the name, or a
 * refusal. Evidence, in order:
 *
 *   1. an absolute path, a `~` path, or an explicit `./` / `../` step — taken as written;
 *   2. the session's own record of paths its read/write/edit calls used;
 *   3. the workspace root.
 *
 * A name that several recorded files share is never resolved by picking one —
 * the answer is the list, and the reader decides.
 *
 * @param ctx - host plugin context.
 * @param request - GET /api/dsh-file-panel.locate?sessionId=…&cwd=…&token=…
 */
async function handleLocate(ctx, request) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const cwd = url.searchParams.get('cwd') ?? ''
  const token = url.searchParams.get('token') ?? ''
  if (token === '') return ok({ kind: 'missing', requested: token, base: cwd === '' ? null : cwd, path: token })

  const asWritten = /^([/\\]|~|[a-zA-Z]:[/\\])/.test(token)
  if (asWritten === true) {
    const absolute = resolveRequestPath(token, cwd === '' ? null : cwd)
    const stats = await statOrNull(absolute)
    return stats === null
      ? ok({ kind: 'missing', requested: token, base: cwd === '' ? null : cwd, path: absolute, source: 'as-written' })
      : ok({ kind: 'open', requested: token, base: cwd === '' ? null : cwd, ...stats, source: 'as-written' })
  }

  // A relative token is only a path when it is one run of characters. A phrase
  // that merely ends in a filename ("same index.js") is prose, and joining it
  // onto a folder is how `/…/plugin/same index.js` gets invented.
  if (/\s/.test(token) === true && /^(\.\.?[/\\])/.test(token) !== true) {
    return ok({ kind: 'not-a-path', requested: token, base: cwd === '' ? null : cwd })
  }

  const wanted = comparablePath(token)
  const base = wanted.split('/').pop() ?? ''
  const sessionEvents = await sessionEventsFor(ctx, sessionId)
  const recorded = sessionId === '' ? [] : recordedPaths(sessionEvents.events)
  const seen = new Set()
  const candidates = []
  const consider = (candidate) => {
    const key = comparablePath(candidate)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    candidates.push({ path: candidate, canonical: key })
  }
  for (const candidate of recorded) {
    const canonical = comparablePath(candidate)
    if (canonical === wanted || canonical.endsWith(`${wanted}`)) consider(candidate)
  }
  for (const candidate of recorded) {
    const tail = comparablePath(candidate).split('/').pop()
    if (tail === base) consider(candidate)
  }

  const existing = []
  for (const candidate of candidates) {
    const stats = await statOrNull(candidate.path)
    if (stats !== null) existing.push(stats)
  }
  if (existing.length === 1) return ok({ kind: 'open', requested: token, base: cwd === '' ? null : cwd, ...existing[0], source: 'session-record' })
  if (existing.length > 1) {
    const exactSuffix = existing.filter((entry) => comparablePath(entry.path).endsWith(wanted))
    if (exactSuffix.length === 1) return ok({ kind: 'open', requested: token, base: cwd === '' ? null : cwd, ...exactSuffix[0], source: 'session-record' })
    return ok({ kind: 'choose', requested: token, base: cwd === '' ? null : cwd, options: (exactSuffix.length > 0 ? exactSuffix : existing).map((entry) => entry.path), source: 'session-record' })
  }

  const joined = resolveRequestPath(token, cwd === '' ? null : cwd)
  const stats = await statOrNull(joined)
  if (stats !== null) return ok({ kind: 'open', requested: token, base: cwd === '' ? null : cwd, ...stats, source: 'workspace-root' })
  // A bare name carries no directory part, so nothing on disk is evidence that
  // its author meant a file: `runtime.visible` is a property, `README.md` may be
  // a footnote. Joining it onto the root and reporting the join as a refusal is
  // how a click that meant nothing turns into "that path is not on disk".
  // Nothing matched => not a path at all, and the reader is left alone.
  if (/[/\\]/.test(token) !== true) {
    return ok({ kind: 'not-a-path', requested: token, base: cwd === '' ? null : cwd, source: 'bare-name' })
  }
  return ok({ kind: 'missing', requested: token, base: cwd === '' ? null : cwd, path: joined, source: 'workspace-root' })
}

/** @param {Request} request */
async function handleStat(request) {
  const url = new URL(request.url)
  const absolute = resolveRequestPath(url.searchParams.get('path'), url.searchParams.get('cwd'))
  const stats = await fsp.stat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') throw failure2('not-found', `no such file: ${absolute}`)
    throw error
  })
  return ok({ path: absolute, size: stats.size, mtimeMs: stats.mtimeMs, isDirectory: stats.isDirectory() })
}

/** @param {Request} request */
async function handleWrite(request) {
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') throw failure2('bad-request', 'a JSON body is required')
  const cwd = typeof body.cwd === 'string' ? body.cwd : null
  const absolute = resolveRequestPath(body.path, cwd)
  if (!isInside(cwd === null ? null : await canonicalize(cwd), await canonicalize(absolute))) {
    throw failure2('forbidden', 'writes are limited to the session workspace')
  }
  if (typeof body.content !== 'string') throw failure2('bad-request', 'content must be a string')
  const existing = await fsp.stat(absolute).catch(() => null)
  if (existing !== null && !existing.isFile()) throw failure2('bad-request', `${absolute} is not a regular file`)
  const before = existing === null ? null : await sha256OfFile(absolute)
  if (typeof body.expectedSha256 === 'string' && body.expectedSha256.length > 0 && before !== null && before !== body.expectedSha256) {
    throw failure2('stale', 'the file changed on disk after it was read; reload before saving')
  }
  const directory = path.dirname(absolute)
  await fsp.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(absolute)}.dsh-file-panel-${process.pid}-${Date.now()}`)
  await fsp.writeFile(temporary, body.content, 'utf8')
  if (existing !== null) await fsp.chmod(temporary, existing.mode).catch(() => {})
  await fsp.rename(temporary, absolute)
  const stats = await fsp.stat(absolute)
  const buffer = Buffer.from(body.content, 'utf8')
  return ok({
    path: absolute,
    created: existing === null,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: sha256OfBuffer(buffer),
    previousSha256: before,
    lines: countLines(body.content).length
  })
}

/**
 * Diagnostics for one session id: which reader answers, and how many events it
 * returns. Used to tell a query-service miss from a log-shape problem.
 * @param {Request} request @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function handleProbe(request, ctx) {
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
  const query = ctx.get('sessionQuery')
  const report = { sessionId, hasQuery: query?.readSession !== undefined }
  if (query?.readSession !== undefined) {
    const queryStarted = Date.now()
    try {
      const loaded = await query.readSession(sessionId)
      const events = loaded?.events ?? loaded?.session?.events ?? loaded?.log?.events
      report.query = { ok: true, keys: Object.keys(loaded ?? {}), events: Array.isArray(events) ? events.length : null, ms: Date.now() - queryStarted }
    } catch (error) {
      report.query = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const located = await locateSessionLog(sessionId)
  report.log = located === null ? null : { path: located.path, size: located.size, mtimeMs: located.mtimeMs }
  if (located !== null) {
    const params = new URL(request.url).searchParams
    const started = Date.now()
    const index = await diffIndexForSession(sessionId, { tailBytes: located.size })
    report.index = {
      source: index?.source ?? null,
      frames: index?.frames ?? 0,
      bytes: index?.bytes ?? 0,
      truncated: index?.truncated ?? false,
      paths: index === null ? 0 : index.index.size,
      ms: Date.now() - started
    }
    if (params.get('sample') === '1') {
      const raw = await fsp.readFile(located.path)
      const { slices } = zstdFrameSlices(raw, 0)
      const sample = []
      for (const [from, to] of slices.slice(0, 3)) {
        try {
          sample.push(JSON.parse(zlib.zstdDecompressSync(raw.subarray(from, to)).toString('utf8')).type)
        } catch {
          sample.push('unreadable')
        }
      }
      report.frames = slices.length
      report.sampleTypes = sample
    }
  }
  return ok(report)
}

/**
 * Serve raw bytes for renderable artifacts (images, PDFs, media).
 * @param {Request} request
 */
async function handleRaw(request) {
  const url = new URL(request.url)
  const absolute = resolveRequestPath(url.searchParams.get('path'), url.searchParams.get('cwd'))
  const stats = await fsp.stat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') throw failure2('not-found', `no such file: ${absolute}`)
    throw error
  })
  if (!stats.isFile()) throw failure2('bad-request', `${absolute} is not a regular file`)
  const maxBytes = Number(url.searchParams.get('maxBytes') ?? MAX_RAW_BYTES)
  if (stats.size > (Number.isFinite(maxBytes) ? maxBytes : MAX_RAW_BYTES)) {
    throw failure2('too-large', `file is larger than the raw preview limit (${Math.round(stats.size / 1048576)} MB)`)
  }
  const bytes = await fsp.readFile(absolute)
  const type = CONTENT_TYPE_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream'
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    }
  })
}

/**
 * Resolve the ripgrep binary the harness bundles (used for content search).
 * @returns {string | null}
 */
function ripgrepPath() {
  if (ripgrepResolved !== undefined) return ripgrepResolved
  ripgrepResolved = null
  // Anchor order matters: the plugin may be symlinked (dev) while the dependency
  // closure lives in the profile, so resolution starts beside the plugin and
  // then walks the profile manifests.
  const home = process.env.DSH_HOME
  const anchors = [import.meta.url]
  if (typeof home === 'string' && home.length > 0) {
    anchors.push(path.join(home, 'profiles', 'web', 'package.json'), path.join(home, 'profiles', 'package.json'))
  }
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const resolved = require('@vscode/ripgrep')?.rgPath
      if (typeof resolved === 'string' && existsSync(resolved)) {
        ripgrepResolved = resolved
        break
      }
    } catch {
      // try the next anchor
    }
  }
  if (ripgrepResolved === null) {
    const roots = []
    if (typeof home === 'string' && home.length > 0) {
      roots.push(path.join(home, 'profiles', 'node_modules', '@vscode'), path.join(home, 'profiles', 'web', 'node_modules', '@vscode'))
    }
    for (const root of roots) {
      let entries = []
      try {
        entries = readdirSync(root)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.startsWith('ripgrep')) continue
        const candidate = path.join(root, entry, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
        if (existsSync(candidate)) {
          ripgrepResolved = candidate
          break
        }
      }
      if (ripgrepResolved !== null) break
    }
  }
  return ripgrepResolved
}

/**
 * Bounded workspace walk collecting file paths (quick open).
 * @param {string} root @param {string} query @param {number} limit
 */
async function searchFileNames(root, query, limit) {
  const needle = query.toLowerCase()
  const matches = []
  const queue = [root]
  let visited = 0
  while (queue.length > 0 && matches.length < limit && visited < MAX_WALK_DIRECTORIES) {
    const directory = queue.shift()
    visited += 1
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue
      }
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (WALK_SKIP.has(entry.name)) continue
        queue.push(child)
        if (needle !== '' && entry.name.toLowerCase().includes(needle)) {
          matches.push({ path: child, relativePath: path.relative(root, child), type: 'directory' })
        }
        continue
      }
      if (!entry.isFile()) continue
      if (needle === '' || entry.name.toLowerCase().includes(needle) || path.relative(root, child).toLowerCase().includes(needle)) {
        matches.push({ path: child, relativePath: path.relative(root, child), type: 'file' })
        if (matches.length >= limit) break
      }
    }
  }
  matches.sort((left, right) => {
    const leftExact = path.basename(left.path).toLowerCase().startsWith(needle) ? 0 : 1
    const rightExact = path.basename(right.path).toLowerCase().startsWith(needle) ? 0 : 1
    if (leftExact !== rightExact) return leftExact - rightExact
    return left.relativePath.length - right.relativePath.length
  })
  return { matches: matches.slice(0, limit), scannedDirectories: visited }
}

/**
 * Content search through the bundled ripgrep, degrading to "unsupported" when
 * the binary is missing rather than failing the request.
 * @param {string} root @param {string} query @param {number} limit
 */
async function searchFileContents(root, query, limit) {
  const rg = ripgrepPath()
  if (rg === null) return { supported: false, matches: [] }
  const args = [
    '--line-number', '--no-heading', '--color', 'never', '--with-filename',
    '--max-count', String(Math.max(1, Math.min(limit, 50))), '--max-filesize', '2M',
    '-e', query, '--', root
  ]
  const result = await new Promise((resolve) => {
    execFile(rg, args, { timeout: SEARCH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ error, stdout: String(stdout ?? '') })
    })
  })
  const matches = []
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) continue
    const first = line.indexOf(':')
    const second = line.indexOf(':', first + 1)
    if (first === -1 || second === -1) continue
    const filePath = line.slice(0, first)
    const lineNumber = Number(line.slice(first + 1, second))
    if (!Number.isFinite(lineNumber)) continue
    matches.push({
      path: filePath,
      relativePath: path.relative(root, filePath),
      line: lineNumber,
      text: line.slice(second + 1).slice(0, 240)
    })
    if (matches.length >= limit) break
  }
  return { supported: true, matches }
}

/**
 * Resolve the file a link pointed at. Chat links are often a bare basename
 * (`index.js`) or a partial path, which the client resolves against the
 * workspace root and misses; this answers with the real file, ranked by what
 * the session actually touched, so a click lands on the intended file instead
 * of a dead end.
 * @param {Request} request @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function handleResolve(request, ctx) {
  const url = new URL(request.url)
  const cwd = url.searchParams.get('cwd')
  const raw = url.searchParams.get('path')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, MAX_SEARCH_RESULTS))
  const absolute = resolveRequestPath(raw, cwd)
  const stats = await fsp.stat(absolute).catch(() => null)
  if (stats !== null) {
    const canonical = await canonicalize(absolute)
    return ok({
      query: raw,
      requested: absolute,
      exists: true,
      isDirectory: stats.isDirectory(),
      path: absolute,
      canonicalPath: canonical,
      relativePath: await relativeTo(cwd, absolute),
      basename: path.basename(absolute),
      candidates: []
    })
  }

  const root = resolveRequestPath(url.searchParams.get('root') ?? cwd, cwd)
  const trimmed = String(raw ?? '').replace(/^[.][/\\]+/u, '').replace(/[/\\]+$/, '')
  const base = path.basename(trimmed)
  const suffix = trimmed.split(path.sep).join('/')

  // Files the session already touched win ties: that is what the agent meant.
  let touched = new Set()
  if (sessionId.length > 0) {
    const index = await sessionDiffIndex(ctx, sessionId)
    const keys = []
    for (const key of index.index.keys()) keys.push(await canonicalize(key))
    touched = new Set(keys)
  }

  const found = await searchFileNames(root, base, MAX_SEARCH_RESULTS)
  const ranked = []
  for (const match of found.matches) {
    if (match.type !== 'file') continue
    const relative = match.relativePath.split(path.sep).join('/')
    const name = path.basename(match.path)
    const canonical = await canonicalize(match.path)
    const stats2 = await fsp.stat(match.path).catch(() => null)
    ranked.push({
      path: match.path,
      canonicalPath: canonical,
      relativePath: relative,
      basename: name,
      exactName: name === base,
      suffixMatch: relative === suffix || relative.endsWith(`/${suffix}`),
      inSession: touched.has(canonical),
      depth: relative.split('/').length,
      mtimeMs: stats2?.mtimeMs ?? 0,
      size: stats2?.size ?? 0
    })
    if (ranked.length >= MAX_SEARCH_RESULTS) break
  }
  ranked.sort((left, right) => {
    if (left.inSession !== right.inSession) return left.inSession ? -1 : 1
    if (left.suffixMatch !== right.suffixMatch) return left.suffixMatch ? -1 : 1
    if (left.exactName !== right.exactName) return left.exactName ? -1 : 1
    if (left.depth !== right.depth) return left.depth - right.depth
    return right.mtimeMs - left.mtimeMs
  })
  return ok({
    query: raw,
    requested: absolute,
    exists: false,
    isDirectory: false,
    path: null,
    canonicalPath: null,
    root,
    candidates: ranked.slice(0, limit)
  })
}

/** @param {Request} request */
async function handleSearch(request) {
  const url = new URL(request.url)
  const cwd = url.searchParams.get('cwd')
  const root = resolveRequestPath(url.searchParams.get('root') ?? cwd, cwd)
  const query = url.searchParams.get('q') ?? ''
  const kind = url.searchParams.get('kind') ?? 'files'
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 60) || 60, MAX_SEARCH_RESULTS))
  if (kind === 'content') {
    if (query.trim().length < 2) return ok({ query, kind, supported: true, matches: [] })
    const found = await searchFileContents(root, query, limit)
    return ok({ query, kind, root, supported: found.supported, matches: found.matches })
  }
  const found = await searchFileNames(root, query, limit)
  return ok({ query, kind: 'files', root, supported: true, matches: found.matches, scannedDirectories: found.scannedDirectories })
}

/**
 * Chunk-level revert: undo one recorded hunk by replacing its `newText` with its
 * `oldText` under a hash guard, so a stale panel cannot clobber a file.
 * @param {Request} request
 */
async function handleRevert(request) {
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') throw failure2('bad-request', 'a JSON body is required')
  const cwd = typeof body.cwd === 'string' ? body.cwd : null
  const absolute = resolveRequestPath(body.path, cwd)
  if (!isInside(cwd === null ? null : await canonicalize(cwd), await canonicalize(absolute))) {
    throw failure2('forbidden', 'reverts are limited to the session workspace')
  }
  const newText = typeof body.newText === 'string' ? body.newText : ''
  const oldText = typeof body.oldText === 'string' ? body.oldText : null
  const current = await fsp.readFile(absolute, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') throw failure2('not-found', `no such file: ${absolute}`)
    throw error
  })
  const before = sha256OfBuffer(Buffer.from(current, 'utf8'))
  if (typeof body.expectedSha256 === 'string' && body.expectedSha256.length > 0 && before !== body.expectedSha256) {
    throw failure2('stale', 'the file changed on disk after this hunk was read; reload before reverting')
  }
  if (newText.length === 0) throw failure2('bad-request', 'the hunk carries no text to replace')
  const at = current.indexOf(newText)
  if (at === -1) throw failure2('stale', 'this hunk is no longer present in the file; it may have been reverted already')
  const next = oldText === null
    ? current.slice(0, at) + current.slice(at + newText.length)
    : current.slice(0, at) + oldText + current.slice(at + newText.length)
  const stats = await fsp.stat(absolute)
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.dsh-file-panel-revert-${process.pid}-${Date.now()}`)
  await fsp.writeFile(temporary, next, 'utf8')
  await fsp.chmod(temporary, stats.mode).catch(() => {})
  await fsp.rename(temporary, absolute)
  return ok({
    path: absolute,
    bytes: Buffer.byteLength(next, 'utf8'),
    sha256: sha256OfBuffer(Buffer.from(next, 'utf8')),
    removedText: newText.length,
    insertedText: oldText === null ? 0 : oldText.length
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
function handleHealth(ctx) {
  return ok({
    plugin: name,
    version: BUILD,
    build: BUILD,
    dshHome: process.env.DSH_HOME ?? null,
    cwd: process.cwd(),
    // What this machine looks like, so a report from any OS is diagnosable
    // without guessing: separators, platform, and optional tooling.
    platform: {
      os: process.platform,
      arch: process.arch,
      separator: path.sep,
      node: process.versions.node,
      ripgrep: ripgrepPath() !== null,
      zstd: typeof zstdDecompressSync === 'function'
    },
    services: {
      sessionQuery: ctx.get('sessionQuery') !== undefined,
      fs: ctx.get('fs') !== undefined,
      shell: ctx.get('shell') !== undefined,
      webServer: ctx.get('webServer') !== undefined
    },
    zstd: typeof zlib.zstdDecompressSync === 'function'
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    ctx.logger?.warn?.('[dsh-file-panel] connection service unavailable; routes not registered')
    return
  }
  const guard = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      ctx.logger?.debug?.(`[dsh-file-panel] ${request.url} failed: ${error instanceof Error ? error.message : String(error)}`)
      return failure(error)
    }
  }
  const routes = [
    [ROUTE_FILE, ['GET'], guard((request) => handleFile(request, ctx))],
    [ROUTE_TREE, ['GET'], guard((request) => handleTree(request))],
    [ROUTE_CHANGES, ['GET'], guard((request) => handleChanges(request, ctx))],
    [ROUTE_DIFF, ['GET'], guard((request) => handleDiff(request, ctx))],
    [ROUTE_STAT, ['GET'], guard((request) => handleStat(request))],
    [ROUTE_DIAG, ['POST'], guard((request) => handleDiag(request))],
    [ROUTE_WRITE, ['POST'], guard((request) => handleWrite(request))],
    [ROUTE_HEALTH, ['GET'], guard(() => Promise.resolve(handleHealth(ctx)))],
    [ROUTE_PROBE, ['GET'], guard((request) => handleProbe(request, ctx))],
    [ROUTE_RAW, ['GET'], guard((request) => handleRaw(request))],
    [ROUTE_SEARCH, ['GET'], guard((request) => handleSearch(request))],
    [ROUTE_REVERT, ['POST'], guard((request) => handleRevert(request))],
    [ROUTE_RESOLVE, ['GET'], guard((request) => handleResolve(request, ctx))],
    [ROUTE_REFERENCES, ['GET'], guard((request) => handleReferences(ctx, request))],
    [ROUTE_LOCATE, ['GET'], guard((request) => handleLocate(ctx, request))],
  ]
  for (const [routePath, methods, fetch] of routes) {
    connection.fetch.register({ path: routePath, methods, fetch })
  }
  ctx.logger?.info?.(`[dsh-file-panel] ${routes.length} routes ready under /api/dsh-file-panel.*`)
}
