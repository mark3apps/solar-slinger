# Changelog

All notable changes to Solar Slinger, newest first. Entries are generated from
the pull requests merged since the previous release — see
[scripts/changelog.mjs](scripts/changelog.mjs) and the
[Build & Release](.github/workflows/release.yml) workflow. Don't hand-edit an
entry expecting it to stick; fix the PR title or description instead.

Releases predating this file are on the
[Releases page](https://github.com/mark3apps/solar-slinger/releases).

## [0.1.24] — 2026-07-31

### Changes

- **Oort cloud redesign: a living glacial wall instead of a dotted ring** ([#24](https://github.com/mark3apps/solar-slinger/pull/24)) — @mark3apps
  The world edge was a faint fog stroke, one dull red ring, and 420 static dots — effectively invisible at gameplay zoom. This rebuilds the Oort cloud as a living glacial wall…
- **Manual releases with generated changelogs** ([#23](https://github.com/mark3apps/solar-slinger/pull/23)) — @mark3apps
  Releases stop being a side effect of merging. The workflow is now manually triggered, takes a patch/minor/major bump, and builds its release notes from the pull requests merged…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.1.23...v0.1.24

