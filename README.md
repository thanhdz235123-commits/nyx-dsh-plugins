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

**From npm**, once the packages are published there:

```bash
npx nyx-file-panel install
npx nyx-message-edit install
```

`npx` fetches from the npm registry, so it only works after a publish — it does
not read GitHub. Installing from the registry needs no account either: only
*publishing* does.

Flags both installers understand: `--force` to overwrite an existing install,
`--home <path>` when the harness home is not the default, `--dep` to install as
a profile dependency instead of a copy. `uninstall` takes it back out.

**Host halves load at boot**: after installing, restart DSH Desktop. Client
halves are picked up with a window reload (⌘R / Ctrl-R).

## Layout

```
packages/nyx-file-panel/     lib/index.js  lib/client.js  lib/types/**  bin/  docs/
packages/nyx-message-edit/   lib/index.js  lib/client.js  lib/types/**  bin/  tools/
```

Both packages are independent: install one, the other, or both.

## License

MIT
