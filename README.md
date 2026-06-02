# GitLab CI Local Runner

A VSCode extension that discovers your GitLab CI jobs and lets you run them
locally with one click, powered by
[`gitlab-ci-local`](https://github.com/firecow/gitlab-ci-local).

## Features

- **Inline play buttons (CodeLens).** A `▶ Run` / `▶ Run with needs` button
  appears above every job in `.gitlab-ci.yml` and `.gitlab/ci/*.yml`, with an
  info line showing `stage · when · allow_failure`.
- **Jobs sidebar.** A dedicated view in the activity bar lists all jobs grouped
  by stage. Click a job to run it; use the context menu to run with needs, run a
  whole stage, or jump to its definition.
- **Filters.** Toolbar toggles to hide `when: never` jobs and to hide jobs/stages
  listed in a project's `.glciconfig.toml` `[skip]` table.
- **Preview & validate.** Run `--preview` (expanded YAML) and
  `--validate-dependency-chain` into an output channel.
- **Auto-refresh.** Editing any CI YAML file re-reads the pipeline.

Jobs run in an integrated terminal, so you get full Docker output and can
`Ctrl-C` a run.

## Requirements

- [`gitlab-ci-local`](https://github.com/firecow/gitlab-ci-local) on your `PATH`
  (or set `glci.binaryPath`).
- Docker (or Podman) available, as required by `gitlab-ci-local`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `glci.projectRoot` | `""` (workspace folder) | Project root where `.gitlab-ci.yml` lives. Absolute, `~`/`$HOME`-prefixed, or relative to the workspace folder. |
| `glci.binaryPath` | `gitlab-ci-local` | Path to the executable. |
| `glci.extraArgs` | `[]` | Raw global args appended to every invocation (e.g. `--volume`). Passed verbatim in the terminal (so `$HOME` expands); env-expanded for listing/preview. |
| `glci.variables` | `{}` | Global CI variables applied as `--variable KEY=VALUE` to every invocation. |
| `glci.ciFileGlobs` | `.gitlab-ci.yml`, `.gitlab/**/*.yml`, … | Files scanned for job definitions. |
| `glci.hideNeverByDefault` | `false` | Hide `when: never` jobs on first open. |
| `glci.terminalPerRun` | `false` | Open a fresh terminal per run instead of reusing one. |

### Project root

By default the extension runs against the first workspace folder. If your CI
project is a subfolder (monorepo), or you're pointing at a different checkout to
debug, set the root explicitly:

- Run **GitLab CI Local: Set Project Root...** (or the folder button in the Jobs
  view title) to pick a folder, or
- set `glci.projectRoot` in settings.

The active root is shown next to the **Jobs** view title and logged to the
output channel on every refresh. Changing it takes effect immediately — no
window reload needed.

### Global args & variables

Configure args and variables once and they apply to every job run, plus the
preview/validate/listing calls.

**Recommended defaults (Basalt projects).** Drop this into your workspace
`.vscode/settings.json` as a good starting point:

```jsonc
{
  // CI variables → become "--variable KEY=VALUE", applied to every invocation.
  "glci.variables": {
    "CRATON_NEXUS_CACERT": "/root/.basalt/basalt-chain.crt",
    "LAB": "true"
  },
  // Raw flags. Each flag and its value is a SEPARATE array element. In the
  // terminal these are passed verbatim, so $HOME expands.
  "glci.extraArgs": [
    "--volume", "$HOME/.basalt:/root/.basalt",
    "--ignore-predefined-vars", "FF_DISABLE_UMASK_FOR_DOCKER_EXECUTOR"
  ]
}
```

This makes every run effectively:

```bash
gitlab-ci-local "<job>" \
  --variable CRATON_NEXUS_CACERT=/root/.basalt/basalt-chain.crt \
  --variable LAB=true \
  --volume $HOME/.basalt:/root/.basalt \
```

> **Note:** in `glci.extraArgs`, keep each flag and its value as separate array
> elements (`"--volume"`, then `"$HOME/.basalt:/root/.basalt"`). A single combined
> string works in the terminal but breaks the non-shell `--list-json`/`--preview`
> calls, where the whole element is passed as one argument.

## Development

```bash
npm install
npm run watch      # esbuild in watch mode
# Press F5 in VSCode to launch the Extension Development Host
npm run compile    # type-check + one-off bundle
npx @vscode/vsce package   # produce a .vsix
```

## How it works

The extension shells out to `gitlab-ci-local --list-json` to discover jobs and
their metadata (`stage`, `when`, `allow_failure`, `needs`, `rules`). It parses
the CI YAML files with [`yaml`](https://github.com/eemeli/yaml) to map each job
to its source line for CodeLens and "go to definition". Running a job simply
sends `gitlab-ci-local "<job>"` to a terminal opened at the workspace root.
