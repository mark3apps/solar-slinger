#!/usr/bin/env node
// Release notes + CHANGELOG generator.
//
// Assembles the notes for a release out of the pull requests merged since the
// previous v* tag, and computes the next version from that tag plus a semver
// bump. Zero dependencies (Node 22 global fetch) and no GitHub Actions context,
// so the exact same invocation works on CI and on a laptop:
//
//   GH_TOKEN=$(gh auth token) node scripts/changelog.js            # preview
//   node scripts/changelog.js --bump minor --json --notes-out x.md # what CI runs
//
// Usage:
//   --bump patch|minor|major   compute the next version (omit = preview only)
//   --since <tag>              override the previous-release tag
//   --notes-out <file>         write the release body here
//   --write-changelog          prepend a dated section to CHANGELOG.md
//   --json                     print {version, tag, since, prCount} to stdout

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

// ---------------------------------------------------------------- args

function parseArgs (argv) {
  const out = { bump: null, since: null, notesOut: null, writeChangelog: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bump') out.bump = argv[++i]
    else if (a === '--since') out.since = argv[++i]
    else if (a === '--notes-out') out.notesOut = argv[++i]
    else if (a === '--write-changelog') out.writeChangelog = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else die(`unknown argument: ${a}`)
  }
  if (out.bump && !['patch', 'minor', 'major'].includes(out.bump)) {
    die(`--bump must be patch, minor or major (got "${out.bump}")`)
  }
  return out
}

function usage () {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
}

function die (msg) {
  console.error(`changelog: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------- git

function git (...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// The newest release tag. Tags are the source of truth for the version — NOT
// package.json, which only ever catches up when a release commits the bump.
function previousTag () {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')
  } catch {
    return null // no releases yet: walk the whole history
  }
}

// Only first-parent commits: on this repo PRs land as real merge commits, so
// first-parent gives one entry per PR instead of every commit inside the branch.
function commitsSince (since) {
  const range = since ? `${since}..HEAD` : 'HEAD'
  const raw = git('log', range, '--first-parent', '--format=%H%x1f%s%x1e')
  return raw.split('\x1e').map(s => s.trim()).filter(Boolean).map(rec => {
    const [sha, subject] = rec.split('\x1f')
    return { sha, subject }
  })
}

function repoSlug () {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const url = git('remote', 'get-url', 'origin')
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/)
  if (!m) die(`cannot derive owner/repo from origin remote: ${url}`)
  return m[1]
}

// ---------------------------------------------------------------- version

function nextVersion (tag, bump) {
  const base = tag ? tag.replace(/^v/, '') : '0.0.0'
  const m = base.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) die(`previous tag "${tag}" is not semver`)
  let [major, minor, patch] = m.slice(1).map(Number)
  if (bump === 'major') { major++; minor = 0; patch = 0 }
  else if (bump === 'minor') { minor++; patch = 0 }
  else patch++
  return `${major}.${minor}.${patch}`
}

// ---------------------------------------------------------------- github api

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

async function api (path) {
  if (!token) die('no GITHUB_TOKEN / GH_TOKEN in the environment (locally: GH_TOKEN=$(gh auth token))')
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'solar-slinger-changelog'
    }
  })
  if (!res.ok) die(`GitHub API ${res.status} on ${path}: ${await res.text()}`)
  return res.json()
}

// PR numbers come from the merge-commit subject where possible (free, no API
// call). Squash merges leave "(#12)" on the subject instead. Anything that
// matches neither gets one lookup against the associated-PRs endpoint, so a
// commit pushed straight to main is still attributed if it came from a PR.
async function prNumberFor (repo, commit) {
  const merge = commit.subject.match(/^Merge pull request #(\d+)/)
  if (merge) return Number(merge[1])
  const squash = commit.subject.match(/\(#(\d+)\)\s*$/)
  if (squash) return Number(squash[1])
  const associated = await api(`/repos/${repo}/commits/${commit.sha}/pulls`)
  return associated.length ? associated[0].number : null
}

// ---------------------------------------------------------------- summaries

// The first line of real prose in a PR body. Bodies here open with a
// "## What changed" heading, so headings, boilerplate and the Claude footer all
// have to be skipped before the paragraph underneath is reached.
function summarize (body) {
  if (!body) return null
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) continue                    // heading
    if (/^[-*]\s*\[[ x]\]/i.test(line)) continue          // checklist item
    if (/^!\[/.test(line)) continue                       // image / badge
    if (/^[>|]/.test(line)) continue                      // quote / table
    if (/^(-{3,}|={3,}|\*{3,})$/.test(line)) continue     // rule
    if (/^co-authored-by:/i.test(line)) continue
    if (/generated with \[?claude/i.test(line)) continue
    const text = stripMarkdown(line.replace(/^[-*+]\s+/, ''))
    if (text.length < 3) continue
    return truncate(text, 180)
  }
  return null
}

function stripMarkdown (s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → their text
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate (s, max) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, '')}…`
}

// ---------------------------------------------------------------- rendering

// Labels aren't in use on this repo yet, so nearly everything falls through to
// "Changes". The map costs nothing and starts sorting the notes the moment PRs
// do get labeled.
const SECTIONS = [
  { title: 'Features', labels: ['enhancement', 'feature'] },
  { title: 'Fixes', labels: ['bug', 'fix'] },
  { title: 'Documentation', labels: ['documentation', 'docs'] },
  { title: 'Changes', labels: [] } // default bucket
]

function sectionFor (labels) {
  const names = labels.map(l => l.name.toLowerCase())
  const hit = SECTIONS.find(s => s.labels.some(l => names.includes(l)))
  return (hit || SECTIONS[SECTIONS.length - 1]).title
}

function renderNotes ({ prs, looseCommits, repo, since, version }) {
  const buckets = new Map()
  for (const pr of prs) {
    const key = sectionFor(pr.labels)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(pr)
  }

  const out = []
  for (const { title } of SECTIONS) {
    const items = buckets.get(title)
    if (!items || !items.length) continue
    out.push(`### ${title}`, '')
    for (const pr of items) {
      out.push(`- **${pr.title}** ([#${pr.number}](${pr.url})) — @${pr.author}`)
      if (pr.summary) out.push(`  ${pr.summary}`)
    }
    out.push('')
  }

  // Direct pushes to main have no PR behind them — list them rather than drop
  // them, so the changelog can never quietly omit shipped work.
  if (looseCommits.length) {
    out.push('### Other changes', '')
    for (const c of looseCommits) out.push(`- ${c.subject} (\`${c.sha.slice(0, 7)}\`)`)
    out.push('')
  }

  if (!out.length) out.push('_No pull requests merged since the previous release._', '')

  if (since) {
    out.push(`**Full changelog:** https://github.com/${repo}/compare/${since}...v${version}`, '')
  }
  return out.join('\n')
}

// The install instructions used to be inlined in the workflow YAML. They belong
// with the rest of the note-building so the workflow carries no prose.
const INSTALL_NOTES = `## Installing

Builds are **unsigned**, so both desktop platforms will object on first launch.

**Updating:** the Windows app and the Linux AppImage keep themselves up to
date — new versions download in the background and install when you quit.
macOS, deb, and rpm builds can't self-install (unsigned / package-managed),
so the app checks for new releases and offers to open the download page.

**macOS:** the app is ad-hoc signed but not notarized, so Gatekeeper blocks the
first launch. Either clear quarantine before opening:
\`xattr -dr com.apple.quarantine "/Applications/Solar Slinger.app"\`
or, after the blocked launch attempt, allow it under
System Settings → Privacy & Security → "Open Anyway".
(Right-click → Open no longer bypasses Gatekeeper on modern macOS.)

**Windows:** SmartScreen may warn because the installer is unsigned —
choose "More info" → "Run anyway".

**Linux (any distro, self-updating):** download the \`.AppImage\` for your
architecture, \`chmod +x\` it, and run it. (Some distros need FUSE2:
\`sudo apt install libfuse2\`.)

**Debian / Ubuntu (x86_64):** \`sudo apt install ./solar-slinger_*_amd64.deb\`

**Raspberry Pi / Linux arm64:** requires a 64-bit OS (Raspberry Pi OS 64-bit on
a Pi 3 or later). \`sudo apt install ./solar-slinger_*_arm64.deb\`

**RHEL / Rocky / Fedora:** \`sudo dnf install ./solar-slinger-*.x86_64.rpm\`
(or the \`.aarch64.rpm\` on arm64)`

// ---------------------------------------------------------------- changelog file

const CHANGELOG_HEADER = `# Changelog

All notable changes to Solar Slinger, newest first. Entries are generated from
the pull requests merged since the previous release — see
[scripts/changelog.mjs](scripts/changelog.mjs) and the
[Build & Release](.github/workflows/release.yml) workflow. Don't hand-edit an
entry expecting it to stick; fix the PR title or description instead.

Releases predating this file are on the
[Releases page](https://github.com/mark3apps/solar-slinger/releases).
`

function writeChangelog (version, notes) {
  const date = new Date().toISOString().slice(0, 10)
  const entry = `## [${version}] — ${date}\n\n${notes.trim()}\n`
  if (!existsSync(CHANGELOG)) {
    writeFileSync(CHANGELOG, `${CHANGELOG_HEADER}\n${entry}`)
    return
  }
  const existing = readFileSync(CHANGELOG, 'utf8')
  const firstEntry = existing.indexOf('\n## ')
  const header = firstEntry === -1 ? existing.trimEnd() : existing.slice(0, firstEntry).trimEnd()
  const rest = firstEntry === -1 ? '' : existing.slice(firstEntry + 1)
  writeFileSync(CHANGELOG, `${header}\n\n${entry}\n${rest}`.replace(/\n{3,}$/, '\n'))
}

// ---------------------------------------------------------------- main

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const repo = repoSlug()
  const since = args.since || previousTag()
  const version = nextVersion(since, args.bump || 'patch')

  const commits = commitsSince(since)
  const prs = []
  const looseCommits = []
  const seen = new Set()

  for (const commit of commits) {
    const number = await prNumberFor(repo, commit)
    if (number == null) { looseCommits.push(commit); continue }
    if (seen.has(number)) continue
    seen.add(number)
    const pr = await api(`/repos/${repo}/pulls/${number}`)
    prs.push({
      number,
      title: pr.title.trim(),
      author: pr.user?.login ?? 'unknown',
      url: pr.html_url,
      labels: pr.labels ?? [],
      summary: summarize(pr.body)
    })
  }

  const notes = renderNotes({ prs, looseCommits, repo, since, version })
  const body = `${notes}\n${INSTALL_NOTES}\n`

  if (args.notesOut) writeFileSync(args.notesOut, body)
  if (args.writeChangelog) writeChangelog(version, notes)

  if (args.json) {
    console.log(JSON.stringify({ version, tag: `v${version}`, since, prCount: prs.length }))
  } else if (!args.notesOut) {
    // Preview mode: the whole point is to read the notes, so print them.
    console.error(`# next version: ${version} (from ${since || 'no previous tag'}, ${prs.length} PRs)\n`)
    console.log(body)
  }
}

main()
