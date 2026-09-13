# Nyx plugins for DeepSeek Harness

Two plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
in one repository, both built the way the harness's own plugins are built —
`lib/index.js` for the host half, `lib/client.js` for the client half, and the
contract in `package.json` (`main`, `exports["./client"]`, `dsh.client`,
`dsh.bundle.patch`).

| package | what it does |
|---|---|
| [`nyx-file-panel`](packages/nyx-file-panel) | File links open a right-side panel — preview, changes, review, files, edit — instead of the OS default app. Exact paths only: a link opens what it names, or says it cannot. |
| [`nyx-message-edit`](packages/nyx-message-edit) | Edit a user message in place: the surface replaces it, everything after it is cut, and one turn regenerates from that exact point. Model picker in the frame, every attempt traced. |

## Install

Each package installs itself into a DSH profile: it copies its halves into the
profile's `node_modules` and writes the profile patch that activates them.

**From a clone** — this is the one path that needs nothing published anywhere,
and the one that is verified end to end:

```bash
git clone https://github.com/thanhdz235123-commits/nyx-dsh-plugins
cd nyx-dsh-plugins
npm run install:plugins          # both plugins; or run one package's bin yourself:
# node packages/nyx-file-panel/bin/nyx-file-panel.mjs install
# node packages/nyx-message-edit/bin/nyx-message-edit.mjs install
```

**From npm** — no clone, no build:

```bash
npx nyx-file-panel install
npx nyx-message-edit install
```

`npx` reads the npm registry only (it never looks at GitHub), so this path needs
the packages to be published — which the `publish` workflow keeps true. Installing
needs no account: only *publishing* does.

Flags both installers understand: `--force` to overwrite an existing install,
`--home <path>` when the harness home is not the default, `--dep` to install as
a profile dependency instead of a copy. `uninstall` takes it back out.

**Host halves load at boot**: after installing, restart DSH Desktop. Client
halves are picked up with a window reload (⌘R / Ctrl-R).

## Privacy

Both plugins are local software: no network calls of their own, no telemetry,
and nothing about you written to disk unless you ask for it.

Two things do touch disk, deliberately:

- `nyx-file-panel` caches a per-session diff index under
  `<DSH_HOME>/nyx-file-panel-index/`, which is what makes reopening a file
  instant. Delete that folder to clear it.
- Diagnostics are **opt-in**: with `NYX_FILE_PANEL_DIAG=1` or
  `NYX_MESSAGE_EDIT_DIAG=1` set, the plugin appends a local JSONL trail to the
  harness home. Message text is never written — only lengths and ids.

`tools/leak-scan.mjs` scans every tracked file for credentials, home paths,
personal addresses and machine names. It runs in `npm run check` and in the
publish workflow, so nothing of that shape can reach the registry through this
repository.

## Layout

```
packages/nyx-file-panel/     lib/index.js  lib/client.js  lib/types/**  bin/  docs/
packages/nyx-message-edit/   lib/index.js  lib/client.js  lib/types/**  bin/  tools/
```

Both packages are independent: install one, the other, or both.

## Publishing (maintainers)

`.github/workflows/publish.yml` publishes **whichever package carries a version
the registry does not have yet**, then skips it on every later run — so the two
packages version independently, and a failed job is safe to re-run.

```bash
git tag v0.6.4 && git push origin v0.6.4     # tag push
gh workflow run publish                       # or manual: Actions → publish → Run workflow
```

It needs one repository secret, `NPM_TOKEN`: an npm **Automation** token (or a
granular token with *bypass 2FA* enabled). npm refuses `npm publish` with an OTP
challenge when the account has two-factor auth on, and an automation token is
the supported way around it — see npm's
[tokens docs](https://docs.npmjs.com/about-access-tokens).

## License

MIT
