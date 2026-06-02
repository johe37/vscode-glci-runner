# GitLab CI Local Runner

A VSCode extension that discovers your GitLab CI jobs and lets you run them
locally with one click, powered by
[`gitlab-ci-local`](https://github.com/firecow/gitlab-ci-local).

## Features

- **Pipeline view.** A modern, GitLab-styled panel (open it from the **graph**
  button in the Jobs view title, the welcome screen, or **GitLab CI Local: Open
  Pipeline View**). Stages are laid out as columns of job cards, each showing its
  latest run status (passed / failed / running / canceled) and badges for
  `manual`, `never`, `allow_failure`, and `needs`. Run a job, run it with needs,
  or jump to its definition straight from the card.
- **Run history.** Every local run is recorded — label, start time, duration,
  and pass/fail status — and shown in the history list at the bottom of the
  Pipeline view. Cancel a running job or re-run a past one with one click.
  History persists per workspace across reloads.
- **Inline play buttons (CodeLens).** A `▶ Run` / `▶ Run with needs` button
  appears above every job in `.gitlab-ci.yml` and `.gitlab/ci/*.yml`, with an
  info line showing `stage · when · allow_failure`.
- **Jobs sidebar.** A dedicated view in the activity bar lists all jobs grouped
  by stage, with a status icon reflecting each job's last local run. Click a job
  to run it; use the context menu to run with needs, run a whole stage, or jump
  to its definition.
- **Filters.** Toolbar toggles to hide `when: never` jobs and to hide jobs/stages
  listed in a project's `.glciconfig.toml` `[skip]` table.
- **Preview & validate.** Run `--preview` (expanded YAML) and
  `--validate-dependency-chain` into an output channel.
- **Auto-refresh.** Editing any CI YAML file re-reads the pipeline.

Jobs run in a dedicated terminal that streams the full Docker output with color.
You can `Ctrl-C` (or click **Cancel**) to abort a run; the extension captures the
exit code and duration so the result lands in the run history.

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

### Showing rule-gated jobs (everything looks `when: never`?)

If most jobs render as `never`, it's usually because their `rules:` depend on
the pipeline context. Run locally on `master`, `gitlab-ci-local` sets
`CI_PIPELINE_SOURCE=push` and `CI_COMMIT_BRANCH=master`, so rules like:

```yaml
rules:
  - if: $CI_PIPELINE_SOURCE == "pipeline"
  - if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH != "master"
  - if: $CI_COMMIT_TAG
```

never match. Simulate the context you want by overriding the predefined
variables via `glci.variables` — these apply to listing too, so the **Pipeline
view updates accordingly**:

```jsonc
{
  "glci.variables": {
    // Activate jobs gated on a pipeline-triggered run:
    "CI_PIPELINE_SOURCE": "pipeline"
    // Or simulate a feature-branch push:
    // "CI_PIPELINE_SOURCE": "push",
    // "CI_COMMIT_BRANCH": "feature/foo"
  }
}
```

> Overriding a *predefined* variable normally makes `gitlab-ci-local` print a
> warning to **stdout** that would corrupt `--list-json`. The extension
> automatically adds every `glci.variables` key to `GCL_IGNORE_PREDEFINED_VARS`
> to suppress it, so prefer `glci.variables` over a `.gitlab-ci-local-variables.yml`
> file for these overrides.

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
to its source line for CodeLens and "go to definition".

Running a job spawns `gitlab-ci-local "<job>"` and pipes its output into a VSCode
pseudoterminal, so you still get live, colored Docker output and can `Ctrl-C` it,
while the extension also captures the exit code and duration. Those results feed
the per-job status shown in the Pipeline view and sidebar, and the persistent run
history (stored in workspace state).
