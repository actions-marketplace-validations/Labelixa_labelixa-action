# Labelixa ZPL Lint — GitHub Action

Lint and preview **ZPL** (and EPL, TSPL, CPCL) label files in your CI.
Every finding in the job summary links to its rule page, pull requests get
before/after previews, and the rendered PNGs are uploaded as an artifact.
A thin wrapper around the [`labelixa` CLI](https://labelixa.com/docs/cli);
no printer required.

```yaml
name: labels
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Labelixa/labelixa-action@v1
        with:
          files: "labels/**/*.zpl"
          fail-on: warning
          api-key: ${{ secrets.LABELIXA_API_KEY }}   # optional; anonymous quota without it
```

## What you get

- **A failing step when it matters.** `fail-on` picks the lowest severity
  that fails the job: `error` (default), `warning`, `info` or `none`.
- **A job summary** with one row per file and every finding linked to its
  rule page (`https://labelixa.com/zpl/rules/<code>`), plus workflow
  annotations on the exact line.
- **Before/after previews** on pull requests, **opt-in** (`previews: true`):
  the base commit's version of each changed label next to the new one, as
  shareable preview links. Off by default because a preview link stores the
  label content on the API. This needs the API's preview feature; when it is
  off or not available the summary keeps the findings and the PNGs stay in
  the artifact.
- **PNG artifact** (`labelixa-previews` by default) with one image per
  label, and the `before/` versions on pull requests.
- **JSON report** (`labelixa-out/report.json`) — the CLI's `--json`
  output, for your own tooling.

## Inputs

| Input | Default | Description |
|---|---|---|
| `files` | `**/*.zpl` | Files or globs, space separated. `**`, `*`, `?` are expanded by the CLI. |
| `fail-on` | `error` | `error`, `warning`, `info` or `none`. |
| `language` | (by extension) | `zpl`, `epl`, `tspl` or `cpcl`. |
| `dpmm` | `8` | ZPL print density: 6, 8, 12 or 24. |
| `width` / `height` | `4` / `6` | ZPL label size in inches. |
| `render` | `true` | Render one PNG per label into `out-dir`. |
| `previews` | `false` | Create shareable preview links for the summary. Uploads each label's content to the API, which stores it as a snippet. |
| `badge` | `false` | Report the result to the Labelixa badge service (see Badges). |
| `artifact` | `true` | Upload `out-dir` as a workflow artifact. |
| `artifact-name` | `labelixa-previews` | Artifact name. |
| `out-dir` | `labelixa-out` | Report and PNG directory. |
| `api-key` | (empty) | Labelixa API key — use a repository secret. |
| `api-url` | `https://api.labelixa.com` | On-premise installations. |
| `cli-version` | `0.3.0` | Version of the `labelixa` npm package to run. |
| `working-directory` | `.` | Where the globs are resolved. |

## Outputs

| Output | Description |
|---|---|
| `failed` | Files with findings at or above `fail-on`. |
| `files` | Files checked. |
| `report` | Path of the JSON report. |

## Exit codes

The step fails with the CLI's exit code: `1` findings at or above
`fail-on`, `2` usage error (no file matched, bad option), `3` API or
network error. A `429` from the API is retried by the CLI, visibly, for the
server's `Retry-After`.

## Badges

Three options, from zero maintenance to live status:

1. **GitHub's own workflow badge** — no extra setup, shows whether the
   workflow passed:
   `![labels](https://github.com/OWNER/REPO/actions/workflows/labels.yml/badge.svg)`
2. **Static badge** — "ZPL validated with Labelixa", no state:
   `[![ZPL validated with Labelixa](https://labelixa.com/static/badge-zpl-validated.svg)](https://labelixa.com/tools/zpl-preview)`
3. **Repository badge** — the lint status of your default branch (or any
   branch with `?branch=`), updated by this action after every branch run:

   ```yaml
   permissions:
     contents: read
     id-token: write        # GitHub signs the run; Labelixa verifies it
   steps:
     - uses: actions/checkout@v5
     - uses: Labelixa/labelixa-action@v1
       with:
         files: "labels/**/*.zpl"
         badge: true
   ```

   `![ZPL lint](https://labelixa.com/badge/gh/OWNER/REPO.svg)`

   The identity is GitHub's OIDC token for the run — there is no Labelixa
   secret to store, and only the repository itself can change its badge.
   Public repositories only; pull request runs do not change the badge.
   The API stores the repository name, branch, commit id, finding counts and
   tool version (never label content) and removes them 180 days after the
   last report. When the badge service is not available the job summary
   says so and nothing else changes. The job summary always carries the
   run's own result badge (`/badge/zpl-lint/passing.svg` or `failing.svg`).

## Notes

- The API key is read from the `api-key` input only and never printed.
  Without a key the anonymous quota applies; for busy repositories create a
  key at https://labelixa.com/panel and store it as a secret.
- Nothing is sent anywhere but the API you configure; label code is not
  stored by the API when linting or rendering. Preview links are the one
  exception: they store the label to serve the shared page, so they are
  off unless you set `previews: true`. Leave the default (`previews: false`)
  if your labels must not leave the job.
- Child processes are started without a shell on every runner, Windows
  included: file globs and `cli-version` are passed as arguments and never
  parsed as commands. `cli-version` must be a version or range.
- Only what the renderer implements is previewed; the linter says so
  (`ZPL1002`) instead of guessing.
