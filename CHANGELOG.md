# Changelog

All notable changes to the Labelixa ZPL Lint action are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-09-28

### Changed
- Preview links are opt-in: `previews` now defaults to `false`. A preview
  link uploads the label content to the API and stores it as a shareable
  snippet, so a workflow author has to ask for it with `previews: true`.

### Security
- No child process is started through a shell, on Windows either: npx is
  run through npm's JavaScript entry point with the current Node binary,
  so file globs and `cli-version` are passed as arguments and never parsed
  as commands. `cli-version` must be a version or range.

## [1.0.0] - 2026-09-23

### Added
- Composite action wrapping the `labelixa` CLI: lints the given files or
  globs (ZPL by default; EPL, TSPL and CPCL by extension or `language`),
  fails the step at the chosen severity (`fail-on`), and writes a JSON
  report.
- Job summary with one row per file, each finding linked to its rule page
  (`https://labelixa.com/zpl/rules/<code>`), plus before/after previews on
  pull requests when the API's preview links are available.
- Rendered PNGs (after, and before on pull requests) uploaded as a
  workflow artifact; workflow annotations on the exact line of each
  finding.
- API key from a repository secret only; anonymous quota without one.
- Result badge in the job summary (`/badge/zpl-lint/passing.svg` or
  `failing.svg`), and an opt-in repository badge (`badge: true`, needs
  `permissions: id-token: write`): the run reports its status with GitHub's
  OIDC token and `https://labelixa.com/badge/gh/OWNER/REPO.svg` shows it.
  Public repositories only; pull request runs leave the badge unchanged.
