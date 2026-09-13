#!/usr/bin/env node
/**
 * Nothing leaves this repository that names its operator.
 *
 * A published plugin is a public artifact: whatever is committed here is on the
 * registry forever, and the publish path is automated — so the check has to be
 * automated too. This scans every tracked file for the shapes that leak:
 * credentials, absolute home paths, personal email addresses, machine names and
 * conversation ids, plus a few operator-specific strings that only make sense
 * on one laptop.
 *
 * Run by `npm run check` and by the publish workflow before anything is
 * uploaded. A hit is a stop, not a warning.
 *
 *   node tools/leak-scan.mjs            # tracked files
 *   node tools/leak-scan.mjs --staged   # only what a commit would add
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** @type {Array<{ name: string, pattern: RegExp, hint: string }>} */
const RULES = [
  {
    name: 'npm token',
    pattern: /\bnpm_[A-Za-z0-9]{20,}/g,
    hint: 'an npm access token — revoke it and keep it in a secret, never in a file'
  },
  {
    name: 'github token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    hint: 'a GitHub token'
  },
  {
    name: 'provider api key',
    pattern: /\b(sk-[A-Za-z0-9]{24,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    hint: 'an API key for an LLM or cloud provider'
  },
  {
    name: 'private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    hint: 'a private key'
  },
  {
    name: 'bearer literal',
    pattern: /\bBearer\s+[A-Za-z0-9._-]{24,}/g,
    hint: 'a hard-coded bearer token'
  },
  {
    name: 'absolute home path',
    // `/Users/me/...` is documentation, `/Users/<someone real>` is a leak.
    pattern: /[/\\](Users|home)[/\\](?!me\b|you\b|user\b|yourname\b|<|\$|\.\.\.)[A-Za-z0-9._-]+/g,
    hint: 'an absolute home path from the machine this was written on'
  },
  {
    name: 'personal email',
    pattern: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|noreply\.|example\.|localhost)[A-Za-z0-9.-]+\.(com|net|org|io|dev|vn|co|me)\b/g,
    hint: 'a personal email address'
  },
  {
    name: 'machine name',
    // A hostname suffix after a real label, never a property read (`flags.home`).
    pattern: /(?<![\w.])[A-Za-z0-9][A-Za-z0-9-]{2,}\.(?:lan|local|internal)\b/g,
    hint: 'a local machine name such as a laptop hostname'
  },
  {
    name: 'session id',
    pattern: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    hint: 'a session id from a real conversation'
  },
  {
    name: 'harness home path',
    pattern: /[/\\]Library[/\\]Application Support[/\\]dsh-desktop[/\\]harness[/\\][A-Za-z0-9._-]+/g,
    hint: 'an absolute path inside one machine\'s harness home'
  }
]

/** Files that are allowed to mention an address, because they must. */
const ALLOWED_EMAIL_DOMAINS = new Set(['users.noreply.github.com'])

const args = process.argv.slice(2)
const staged = args.includes('--staged')

function files() {
  const command = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files']
  return execFileSync('git', command, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Binary files are skipped: no text, nothing to leak (images are reviewed by eye). */
function textOf(file) {
  const buffer = readFileSync(file)
  if (buffer.includes(0)) return null
  return buffer.toString('utf8')
}

const findings = []
for (const file of files()) {
  let text
  try {
    text = textOf(file)
  } catch {
    continue
  }
  if (text === null) continue
  const lines = text.split('\n')
  for (const rule of RULES) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(line)) !== null) {
        const hit = match[0]
        if (rule.name === 'personal email' && ALLOWED_EMAIL_DOMAINS.has(hit.split('@')[1])) continue
        findings.push({ file, line: index + 1, rule: rule.name, hit, hint: rule.hint })
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`leak-scan: clean (${files().length} files, ${RULES.length} rules)`)
  process.exit(0)
}

console.error(`leak-scan: ${findings.length} finding(s)\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.hit}`)
  console.error(`     ${finding.hint}`)
}
console.error('\nNothing is published until this is clean.')
process.exit(1)
