#!/usr/bin/env node
/**
 * dsh-message-edit installer.
 *
 * Installs the plugin into a DeepSeek Harness profile on any machine:
 *
 *   npx --yes github:thanhdz235123-commits/dsh-message-edit install
 *   node bin/dsh-message-edit.mjs install --home "/path/to/harness"
 *
 * Two shapes are supported:
 *
 *   copy  (default)  the package files are placed under <profile>/node_modules
 *                    and inserted from the profile's own patch layer. No package
 *                    manager runs, no lockfile is touched, nothing else moves.
 *   --dep            the package is added to the profile's package.json
 *                    dependencies + dsh.profile.bundles and the profile's own
 *                    package manager installs it — the same shape dshmarket
 *                    uses for third-party plugins.
 *
 * The host half imports nothing from the harness, so it works from either
 * installation shape without a dependency tree of its own.
 *
 * Every command is idempotent and reversible; `uninstall` removes exactly what
 * `install` wrote.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, copyFileSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-message-edit'
const AUTHOR = 'thanhdz235123-commits'
const REPO = `https://github.com/${AUTHOR}/${PACKAGE}`
const DEFAULT_SPEC = `github:${AUTHOR}/${PACKAGE}`
const MARK_START = `# >>> ${PACKAGE} (managed by \`${PACKAGE} install\` — do not edit between the markers)`
const MARK_END = `# <<< ${PACKAGE}`
const ASSETS = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
const bold = (text) => paint('1', text)
const dim = (text) => paint('2', text)
const green = (text) => paint('32', text)
const yellow = (text) => paint('33', text)
const red = (text) => paint('31', text)

let jsonMode = false
const say = (line = '') => {
  if (jsonMode !== true) console.log(line)
}

// ---------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------

/** Where the harness keeps its home on this platform, in the order DSH itself uses. */
function candidateHomes() {
  const home = homedir()
  const os = platform()
  if (os === 'darwin') return [path.join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness')]
  if (os === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'dsh-desktop', 'harness')]
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return [path.join(configHome, 'dsh-desktop', 'harness'), path.join(home, '.dsh-desktop', 'harness')]
}

function resolveHome(flags) {
  const explicit = flags.home ?? process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.length > 0) {
    const resolved = path.resolve(explicit)
    return { home: resolved, how: flags.home !== undefined ? '--home' : 'DSH_HOME' }
  }
  const found = candidateHomes().find((candidate) => existsSync(candidate))
  if (found !== undefined) return { home: found, how: 'platform default' }
  const first = candidateHomes()[0]
  return {
    home: first,
    how: 'platform default',
    missing: `no harness home at ${first} — start DSH Desktop once, or pass --home <dir>`
  }
}

function profilePaths(home, profile) {
  const root = path.join(home, 'profiles', profile)
  return {
    root,
    packageJson: path.join(root, 'package.json'),
    patch: path.join(root, 'cordis.patch.yml'),
    modules: path.join(root, 'node_modules'),
    target: path.join(root, 'node_modules', PACKAGE)
  }
}

// ---------------------------------------------------------------------------
// patch layer
// ---------------------------------------------------------------------------

function insertBlock() {
  return `${MARK_START}\n- insert:\n    - id: ${PACKAGE}\n      name: ${PACKAGE}\n${MARK_END}\n`
}

/** Whether a row for this plugin already exists, marked or hand-written. */
function patchState(text) {
  if (text.includes(MARK_START)) return 'marked'
  // A row inside a shared insert block is one indented `- id:` line; matching
  // it is what keeps `install` idempotent instead of duplicating the entry.
  if (new RegExp(`^\\s*-\\s+id:\\s*${PACKAGE}\\s*$`, 'm').test(text)) return 'present'
  const loose = new RegExp(`-\\s*insert:\\s*\\n(\\s*)-\\s*id:\\s*${PACKAGE}\\s*\\n`)
  if (loose.test(text)) return 'present'
  return 'absent'
}

/** YAML payload of a patch file with its comments and blank lines dropped. */
function patchPayload(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('#') !== true)
    .join('\n')
    .trim()
}

/**
 * Row lines for one plugin, at the indentation of the block's existing rows.
 * @param id - plugin id, used for both `id` and `name`.
 * @param indent - leading whitespace of a sibling `- id:` line.
 * @returns the two YAML lines.
 */
function insertRowLines(id, indent) {
  return [`${indent}- id: ${id}`, `${indent}  name: ${id}`]
}

/**
 * Extend an existing top-level `- insert:` row with one more entry.
 *
 * The patch layer must stay a SINGLE YAML document — `js-yaml.load()`, which
 * the harness boots through, throws on a multi-document stream, so appending a
 * second `- insert:` block would stop the app from starting. An existing row is
 * therefore extended in place.
 *
 * @param text - current patch file.
 * @param id - plugin id to add.
 * @returns the merged text, or null when there is no insert block to extend.
 */
function mergeIntoInsertBlock(text, id) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^- insert:\s*$/.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    if (lines[index].search(/\S/) === 0) {
      end = index
      break
    }
  }
  let indent = null
  let lastChild = start
  for (let index = start + 1; index < end; index += 1) {
    const match = /^(\s*)-\s+id:\s*\S+/.exec(lines[index])
    if (match !== null && indent === null) indent = match[1]
    if (lines[index].trim() !== '') lastChild = index
  }
  if (indent === null) return null
  const inserted = insertRowLines(id, indent)
  return [...lines.slice(0, lastChild + 1), ...inserted, ...lines.slice(lastChild + 1)].join('\n')
}

/**
 * Drop this plugin's `- id:`/`name:` pair from a shared insert block, leaving
 * every other row (and the surrounding comments) exactly as they were.
 * @param text - current patch file.
 * @param id - plugin id to drop.
 * @returns the pruned text, or null when the pair is not present.
 */
function dropRowFromInsertBlock(text, id) {
  const lines = text.split('\n')
  const removed = []
  const idPattern = new RegExp(`^\\s*-\\s+id:\\s*${id}\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (idPattern.test(lines[index]) !== true) continue
    const indent = lines[index].search(/\S/)
    let stop = index + 1
    while (stop < lines.length && lines[stop].trim() !== '' && lines[stop].search(/\S/) > indent) stop += 1
    removed.push([index, stop])
    index = stop - 1
  }
  if (removed.length === 0) return null
  const kept = []
  let cursor = 0
  for (const [from, to] of removed) {
    kept.push(...lines.slice(cursor, from))
    cursor = to
  }
  kept.push(...lines.slice(cursor))
  return kept.join('\n')
}

function ensurePatchEntry(patchFile) {
  const before = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const state = patchState(before)
  // 'marked' and 'present' both mean the row is already there — never add a second one.
  if (state === 'marked' || state === 'present') return { changed: false, state }
  const payload = patchPayload(before)
  // An empty layer is literally `[]`; replace the placeholder rather than grow
  // it into a second document.
  if (payload === '' || payload === '[]') {
    writeFileSync(patchFile, insertBlock())
    return { changed: true, state: state === 'manual' ? 'manual+marked' : 'added' }
  }
  const merged = mergeIntoInsertBlock(before, PACKAGE)
  if (merged !== null) {
    writeFileSync(patchFile, merged)
    return { changed: true, state: 'merged' }
  }
  const next = `${before.replace(/\s*$/, '\n')}\n${insertBlock()}`
  writeFileSync(patchFile, next)
  return { changed: true, state: state === 'manual' ? 'manual+marked' : 'added' }
}

function removePatchEntry(patchFile) {
  if (existsSync(patchFile) !== true) return { changed: false, state: 'absent' }
  const before = readFileSync(patchFile, 'utf8')
  let next = null
  let state = 'removed'

  if (before.includes(MARK_START) !== true && before.includes(`- id: ${PACKAGE}`) === true) {
    // The row lives in a block this installer shares with another plugin (or
    // one written by hand): drop only this plugin's pair.
    const pruned = dropRowFromInsertBlock(before, PACKAGE)
    if (pruned !== null) {
      next = pruned
      state = 'merged'
    }
  }

  if (next !== null) {
    // fall through to the shared normalization below
  } else if (before.includes(MARK_START) === true) {
    const start = before.indexOf(MARK_START)
    const endIndex = before.indexOf(MARK_END, start)
    const end = endIndex === -1 ? before.length : endIndex + MARK_END.length
    next = `${before.slice(0, start)}${before.slice(end)}`
  } else if (patchState(before) === 'manual') {
    // A row someone wrote by hand. Removed only when the block is exactly this
    // plugin's insert — a block that also configures something else is left
    // alone and reported.
    const lines = before.split('\n')
    const kept = []
    let index = 0
    let removed = false
    while (index < lines.length) {
      const line = lines[index]
      if (/^\s*-\s*insert:\s*$/.test(line)) {
        const indent = line.search(/\S/)
        let stop = index + 1
        while (stop < lines.length && (lines[stop].trim() === '' || lines[stop].search(/\S/) > indent)) stop += 1
        const block = lines.slice(index, stop).join('\n')
        const ids = [...block.matchAll(/-\s*id:\s*([^\s#]+)/g)].map((match) => match[1])
        if (ids.length === 1 && ids[0] === PACKAGE) {
          while (kept.length > 0 && kept[kept.length - 1].trim().startsWith('#') && kept[kept.length - 1].includes(PACKAGE)) kept.pop()
          index = stop
          removed = true
          continue
        }
      }
      kept.push(line)
      index += 1
    }
    if (removed === true) next = kept.join('\n')
    else state = 'unmarked'
  } else {
    return { changed: false, state: 'absent' }
  }

  if (next === null) return { changed: false, state }
  next = next.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n')
  // An emptied patch layer has to stay valid YAML — and keeps its comments.
  // A `- insert:` row left with no children is equally invalid (`insert: null`)
  // and would be rejected at boot.
  const emptied = patchPayload(next) === '' || /^- insert:\s*$/.test(patchPayload(next))
  if (emptied) {
    const comments = next.split('\n').filter((line) => line.trim().startsWith('#'))
    next = comments.length === 0 ? '[]\n' : `${comments.join('\n')}\n\n[]\n`
  }
  writeFileSync(patchFile, next)
  return { changed: true, state }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function packageManagerFor(profile) {
  const manifest = readJson(profile.packageJson)
  if (manifest !== null && manifest.pnpm !== undefined) return 'pnpm'
  if (existsSync(path.join(profile.root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(profile.root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

function detectBuild(source) {
  const entry = path.join(source, 'index.js')
  if (existsSync(entry) !== true) return null
  const match = /BUILD\s*=\s*'([^']+)'/.exec(readFileSync(entry, 'utf8'))
  return match === null ? null : match[1]
}

function install(flags) {
  const { home, how, missing } = resolveHome(flags)
  if (missing !== undefined && existsSync(home) !== true) fail(missing)
  const profile = profilePaths(home, flags.profile)
  if (existsSync(profile.root) !== true) fail(`no "${flags.profile}" profile at ${profile.root} — run DSH Desktop once so it creates one`)

  const source = flags.source ?? PLUGIN_ROOT
  const build = detectBuild(source)
  const report = { command: 'install', home, homeSource: how, profile: profile.root, mode: flags.dep === true ? 'dependency' : 'copy', source, build, steps: [] }

  mkdirSync(profile.modules, { recursive: true })

  if (flags.dep === true) {
    const manifest = readJson(profile.packageJson)
    if (manifest === null) fail(`cannot read ${profile.packageJson}`)
    const spec = flags.spec ?? DEFAULT_SPEC
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE]: spec }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (bundles.includes(PACKAGE) !== true) {
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles, PACKAGE] } }
    }
    writeFileSync(profile.packageJson, `${JSON.stringify(manifest, null, 2)}\n`)
    report.steps.push(`added "${PACKAGE}": "${spec}" to ${path.relative(home, profile.packageJson)}`)
    // A bundle brings its own patch layer with it, so the hand-written row would
    // insert the plugin a second time. The two activation paths never overlap.
    const dropped = removePatchEntry(profile.patch)
    if (dropped.changed === true) report.steps.push(`bundle takes over insertion — dropped the hand-written row from ${path.relative(home, profile.patch)}`)
    report.depMode = true
    const manager = packageManagerFor(profile)
    try {
      run(manager, manager === 'yarn' ? ['install'] : ['install', '--no-audit', '--no-fund'], profile.root)
      report.steps.push(`${manager} install finished`)
    } catch (error) {
      report.steps.push(`${manager} install failed: ${String(error.message).split('\n')[0]}`)
      report.warning = `run "${manager} install" in ${profile.root} yourself`
    }
  } else {
    if (existsSync(profile.target) === true && flags.force === true) rmSync(profile.target, { recursive: true, force: true })
    mkdirSync(profile.target, { recursive: true })
    const copied = []
    for (const asset of readdirSync(source)) {
      const from = path.join(source, asset)
      if (statSync(from).isDirectory() !== true && asset.startsWith('.') !== true) {
        copyFileSync(from, path.join(profile.target, asset))
        copied.push(asset)
      }
    }
    for (const directory of ['bin', 'tools']) {
      const from = path.join(source, directory)
      if (existsSync(from) === true) cpSync(from, path.join(profile.target, directory), { recursive: true })
    }
    for (const asset of ASSETS) {
      const from = path.join(source, asset)
      if (existsSync(from) === true && copied.includes(asset) !== true) copyFileSync(from, path.join(profile.target, asset))
    }
    report.steps.push(`copied ${readdirSync(profile.target).length} entries to ${path.relative(home, profile.target)}`)
  }

  if (flags.dep !== true) {
    // Same rule from the other side: a copy install is activated by the profile
    // patch layer, so an older dependency/bundle installation is retired first.
    const manifest = readJson(profile.packageJson)
    const bundles = manifest?.dsh?.profile?.bundles
    if (manifest?.dependencies?.[PACKAGE] !== undefined || (Array.isArray(bundles) && bundles.includes(PACKAGE))) {
      if (manifest?.dependencies?.[PACKAGE] !== undefined) delete manifest.dependencies[PACKAGE]
      if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE)
      writeFileSync(profile.packageJson, `${JSON.stringify(manifest, null, 2)}\n`)
      report.steps.push(`retired the dependency + bundle entry in ${path.relative(home, profile.packageJson)} (copy mode activates through the patch layer)`)
    }
  }
  if (flags.dep !== true) {
    const patch = ensurePatchEntry(profile.patch)
    report.steps.push(`patch layer ${path.relative(home, profile.patch)}: ${patch.changed ? `insert row ${patch.state}` : `already present (${patch.state})`}`)
  } else {
    report.steps.push(`patch layer untouched — the bundle inserts the plugin itself`)
  }
  report.howToFinish = [
    'Restart DSH Desktop so the host half (Agent edit hook + routes) is loaded.',
    'Client half: reload the DSH window (Cmd-R / Ctrl-R) so client.js is picked up.'
  ]
  return report
}

function uninstall(flags) {
  const { home, how } = resolveHome(flags)
  const profile = profilePaths(home, flags.profile)
  const report = { command: 'uninstall', home, homeSource: how, profile: profile.root, steps: [] }

  if (existsSync(profile.target) === true) {
    rmSync(profile.target, { recursive: true, force: true })
    report.steps.push(`removed ${path.relative(home, profile.target)}`)
  } else {
    report.steps.push('package directory was not there')
  }

  const patch = removePatchEntry(profile.patch)
  if (patch.changed === true) report.steps.push(`removed the insert row from ${path.relative(home, profile.patch)}`)
  else if (patch.state === 'unmarked') {
    report.steps.push(`the insert row in ${path.relative(home, profile.patch)} was not written by this installer — leaving it alone`)
    report.manual = `delete the "${PACKAGE}" row from ${profile.patch} by hand`
  } else report.steps.push('patch layer already clean')

  const manifest = readJson(profile.packageJson)
  if (manifest?.dependencies?.[PACKAGE] !== undefined) {
    delete manifest.dependencies[PACKAGE]
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE)
    writeFileSync(profile.packageJson, `${JSON.stringify(manifest, null, 2)}\n`)
    report.steps.push(`removed the dependency + bundle entry from ${path.relative(home, profile.packageJson)}`)
    report.warning = `run "${packageManagerFor(profile)} install" in ${profile.root} to prune node_modules`
  }
  report.howToFinish = ['Reload the DSH window (Cmd-R / Ctrl-R).']
  return report
}

function status(flags) {
  const { home, how, missing } = resolveHome(flags)
  const profile = profilePaths(home, flags.profile)
  const patchText = existsSync(profile.patch) ? readFileSync(profile.patch, 'utf8') : ''
  const manifest = readJson(profile.packageJson)
  const installed = existsSync(profile.target) === true
  return {
    command: 'status',
    home,
    homeSource: how,
    homeExists: existsSync(home),
    profile: profile.root,
    note: missing ?? null,
    installed,
    source: installed ? 'copy' : (manifest?.dependencies?.[PACKAGE] !== undefined ? 'dependency' : null),
    dependency: manifest?.dependencies?.[PACKAGE] ?? null,
    inBundles: Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.includes(PACKAGE) : false,
    patchRow: patchState(patchText),
    build: installed ? detectBuild(profile.target) : null
  }
}

function doctor(flags) {
  const { home, how } = resolveHome(flags)
  const profile = profilePaths(home, flags.profile)
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, `node ${process.versions.node}`)
  add('harness home', existsSync(home), home)
  add(`profile "${flags.profile}"`, existsSync(profile.root), profile.root)
  add('profile package.json', existsSync(profile.packageJson), path.relative(home, profile.packageJson))
  add('patch layer', existsSync(profile.patch), path.relative(home, profile.patch))
  add('shared profile modules', existsSync(path.join(home, 'profiles', 'node_modules')), 'profiles/node_modules (created by the first DSH launch)')
  return { command: 'doctor', home, homeSource: how, checks, ok: checks.every((check) => check.ok === true) }
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function fail(message) {
  if (jsonMode === true) console.log(JSON.stringify({ ok: false, error: message }))
  else {
    console.error(`${red('✗')} ${message}`)
    console.error(dim('  run with --help to see the options'))
  }
  process.exit(1)
}

function parseArgs(argv) {
  const flags = { profile: 'web', command: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--home') flags.home = argv[++index]
    else if (arg === '--profile') flags.profile = argv[++index]
    else if (arg === '--spec') flags.spec = argv[++index]
    else if (arg === '--source') flags.source = argv[++index]
    else if (arg === '--dep') flags.dep = true
    else if (arg === '--force') flags.force = true
    else if (arg === '--json') jsonMode = true
    else if (arg === '-h' || arg === '--help') flags.command = 'help'
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`)
    else if (flags.command === null) flags.command = arg
    else fail(`unexpected argument ${arg}`)
  }
  return flags
}

const HELP = `${bold(`${PACKAGE} — installer`)}

${dim('USAGE')}
  npx --yes github:${AUTHOR}/${PACKAGE} install
  node bin/${PACKAGE}.mjs <command> [options]

${dim('COMMANDS')}
  install      put the panel into a DSH profile (copy mode by default)
  uninstall    remove the package directory, the patch row and the dependency
  status       report what is installed where, and which build
  doctor       check that this machine can host the plugin
  help         this text

${dim('OPTIONS')}
  --home <dir>       harness home (default: $DSH_HOME, else the platform default)
  --profile <name>   profile name (default: web)
  --dep              add it as a package dependency + bundle instead of copying
  --spec <spec>      dependency spec for --dep (default: ${DEFAULT_SPEC})
  --source <dir>     install from another checkout
  --force            replace an existing copy
  --json             machine-readable output
  -h, --help

${dim('AFTER INSTALLING')}
  Restart DSH Desktop: the host half registers the Agent edit hook and the
  /api/dsh-message-edit.* routes at harness start. The client half (pencil,
  inline editor, transcript hiding) then loads with the window; reloading the
  window alone (Cmd-R / Ctrl-R) is enough for later client-only updates.
`

function main() {
  const flags = parseArgs(process.argv.slice(2))
  const command = flags.command ?? 'help'
  if (command === 'help') return void say(HELP)

  const handlers = { install, uninstall, status, doctor }
  const handler = handlers[command]
  if (handler === undefined) fail(`unknown command "${command}"`)

  const report = handler(flags)
  if (jsonMode === true) return void console.log(JSON.stringify({ ok: true, ...report }, null, 2))

  say(`${bold(`${PACKAGE} ${command}`)}`)
  say(`  ${dim('home')}     ${report.home} ${dim(`(${report.homeSource})`)}`)
  if (report.profile !== undefined) say(`  ${dim('profile')}  ${report.profile}`)
  if (report.mode !== undefined) say(`  ${dim('mode')}     ${report.mode}${report.build === null || report.build === undefined ? '' : dim(` · build ${report.build}`)}`)
  for (const step of report.steps ?? []) say(`  ${green('•')} ${step}`)
  if (report.warning !== undefined) say(`  ${yellow('!')} ${report.warning}`)
  if (report.manual !== undefined) say(`  ${yellow('!')} ${report.manual}`)
  if (report.note !== null && report.note !== undefined) say(`  ${yellow('!')} ${report.note}`)
  if (report.checks !== undefined) {
    for (const check of report.checks) say(`  ${check.ok ? green('✓') : red('✗')} ${check.name} ${dim(check.detail)}`)
    if (report.ok !== true) process.exit(1)
  }
  if (report.installed !== undefined) {
    say(`  ${report.installed ? green('installed') : yellow('not installed')}${report.source === null ? '' : dim(` (${report.source})`)}${report.build === null ? '' : dim(` · build ${report.build}`)}`)
    if (jsonMode !== true) say(`  ${dim(`dependency=${report.dependency ?? 'none'} bundles=${report.inBundles} patch=${report.patchRow}`)}`)
  }
  for (const line of report.howToFinish ?? []) say(`  ${dim('→')} ${line}`)
}

main()
