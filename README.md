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

Each package installs itself into a DSH profile — it copies its halves into the
profile's `node_modules` and writes the profile patch that activates them:

```bash
npx nyx-file-panel install
npx nyx-message-edit install
```

Add `--force` to overwrite an existing install, `--home <path>` when the harness
home is not the default, `--dep` to install as a profile dependency instead of a
copy. `npx nyx-file-panel uninstall` takes it back out.

From a clone (no npm publish needed):

```bash
git clone https://github.com/thanhdz235123-commits/nyx-dsh-plugins
cd nyx-dsh-plugins/packages/nyx-file-panel && node bin/nyx-file-panel.mjs install
```

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
