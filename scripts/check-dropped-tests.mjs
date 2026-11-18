#!/usr/bin/env node
/**
 * Fail when a branch would delete test cases that exist on the base.
 *
 * This exists because it happened twice in one day and git said nothing both
 * times. A branch opened before several PRs landed replaces a whole test file
 * rather than merging it, so there is no textual conflict — the file is simply
 * the older version plus the author's additions. Merging it silently removes
 * every case added in between.
 *
 * Observed on Lens #480 (19 cases: the Zod argument suite and the upstream
 * deadline suite) and again on #492 (the same 19). Both reported "mergeable",
 * both typechecked, and in both cases the loss was only visible by counting
 * `it(` on each side.
 *
 * What this does NOT do: run the tests, or judge whether a removal is correct.
 * Removing a test is sometimes exactly right — the feature went away, the case
 * was a duplicate, the assertion was wrong. It reports which cases disappear so
 * the decision is made deliberately rather than by accident. Say so in the PR
 * and apply the override label.
 *
 * Compares the base against the MERGE RESULT, not against the branch tip.
 * Comparing against the tip over-reports wildly — a branch 47 commits behind
 * is "missing" every case added since it forked, whether or not merging would
 * drop them. What matters is the tree that would actually land.
 *
 *   node scripts/check-dropped-tests.mjs <base-ref> [head-ref]
 *
 * Exits 1 when cases are missing from the merge result, 0 otherwise.
 */
import { execFileSync } from 'node:child_process'

const BASE = process.argv[2] ?? 'origin/main'
const HEAD = process.argv[3] ?? 'HEAD'

/** Matches `it('…`, `test("…`, and the `.each`/`.only`/`.skip` variants. */
const CASE = /^\s*(?:it|test)(?:\.\w+)*\s*(?:\(|`)\s*(['"`])(.*?)\1/gm

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Test files tracked at a ref. */
function testFilesAt(ref) {
  return git('ls-tree', '-r', '--name-only', ref)
    .split('\n')
    .filter(f => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
}

/** Map of "file :: case name" for every test case at a ref. */
function casesAt(ref) {
  const cases = new Map()
  for (const file of testFilesAt(ref)) {
    let source
    try {
      source = git('show', `${ref}:${file}`)
    } catch {
      continue
    }
    for (const m of source.matchAll(CASE)) {
      // Keyed by file AND name: the same name in two files is two cases, and a
      // case merely moving between files should still be reported, because a
      // move and a deletion look identical from the base's point of view.
      cases.set(`${file} :: ${m[2]}`, true)
    }
  }
  return cases
}

/**
 * The tree merging HEAD into BASE would produce. Falls back to HEAD itself if
 * the merge conflicts — a conflicted PR has other problems and the comparison
 * is still worth printing.
 */
function mergeResult(base, head) {
  try {
    return git('merge-tree', '--write-tree', base, head).trim().split('\n')[0]
  } catch (e) {
    // A conflicted merge still writes the tree it got to, on stdout.
    const out = String(e.stdout ?? '').trim().split('\n')[0]
    if (out) {
      console.log('Note: the merge conflicts; comparing against its tree anyway.\n')
      return out
    }
    console.log('Note: could not compute a merge tree; comparing against the branch tip.\n')
    return head
  }
}

const merged = mergeResult(BASE, HEAD)
const base = casesAt(BASE)
const head = casesAt(merged)
const missing = [...base.keys()].filter(k => !head.has(k))

console.log(`base ${BASE}: ${base.size} cases`)
console.log(`merging ${HEAD}: ${head.size} cases`)

if (missing.length === 0) {
  console.log('\nNo test case present on the base is missing from this branch.')
  process.exit(0)
}

console.log(`\n${missing.length} test case(s) on ${BASE} would be removed by merging:\n`)
for (const k of missing) console.log(`  - ${k}`)
console.log(
  '\nIf that is deliberate — the feature went away, the case was a duplicate,' +
    '\nthe assertion was wrong — say so in the PR and apply the' +
    '\n`tests-removed-intentionally` label.' +
    '\n\nIf it is not, the usual cause is a branch opened before other PRs' +
    '\nlanded: merging `main` in replaces the file wholesale and takes the' +
    '\ncases added in between with it. Rebase, then keep both sides.',
)
process.exit(1)
