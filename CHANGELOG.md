# Changelog

This fork is derived from [`dsh-loop-guard`](https://github.com/MrWeiCodes/dsh-loop-guard)
by argszero, MrWeiCodes and contributors, used under the MIT License. The
original project's own history is preserved below the fork entry.

## 1.1.0 — trim fork

Adds tail trimming to the mid-stream breakers, and makes both notices
configurable. Everything in 1.0.4 is unchanged unless noted.

### Added

- **`trimRepeatedTail`** (boolean, default `true`). When a mid-stream breaker
  fires, the repetition the detector measured is stripped from the block before
  it is committed. The break path closes each open block with a `block-end`
  payload that wins over the accumulated deltas, so this is the last point at
  which the text entering the context can still be changed — without it, the
  degenerate tail is committed to the history and the resumed turn reads it back.

  The amount removed is the detector's own reported figure, not a re-derivation:
  for the cycle rules that figure *is* the periodic tail span.

  Two safety properties:

  - **A block is never emptied.** A block with no non-whitespace text is
    invisible to the UI, and an all-empty `content` array is the shape that
    historically withdrew a materialized target. `MIN_TRIM_KEEP` (256) is a floor
    on what a trimmed block may retain; below it the block is committed whole and
    a warning is logged.
  - **Fail-open.** Any failure returns the original text. A guard must never be
    the reason a session dies.

- **`correctionTemplate`** (string, default `''`). Replaces the correction text
  injected after a break. Placeholders `{what}`, `{chars}` and `{trimmed}` are
  substituted; an empty string keeps the built-in wording. An unknown placeholder
  is left verbatim rather than throwing.

- **`trimNoticeTemplate`** (string, default `''`). Replaces the notice appended
  after the correction when a trim actually happened. Same placeholders.

- `test/trim.spec.mjs` — 14 tests covering the trim, the keep-floor, the
  fail-open paths, and every template behaviour.

### Changed

- The built-in correction wording is more prescriptive. The previous text
  invited a looping model back into the same register; the new text forbids
  preparation, transition and self-nudging language and offers exactly three
  exits (emit a tool call / give the final answer / report `BLOCKED`).
- The trim notice is a separate part from the correction rather than a suffix of
  it, so the two are independently configurable.
- `src/index.ts` now carries the shipped behaviour. It previously did not: the
  trim existed only in the built `lib/`, which meant `npm run build` silently
  removed it. Source and artifact are now consistent.
- `package.json`: renamed to `@kongbaige010/dsh-loop-guard-trim`, version
  `1.1.0`, `author`/`contributors` record the fork, and `files` ships `src/`
  and this changelog so the published tarball is reproducible from source.

### Fixed

- **`cordis.patch.yml` still mounted the upstream package.** The patch's
  `insert[].name` was left as `'dsh-loop-guard'`, so a profile using this
  bundle patch would have loaded the *original* build — the one without tail
  trimming — while still registering the plugin id `loop-guard`. It now names
  `@kongbaige010/dsh-loop-guard-trim`.
- Config fields that were absent on a hand-built config object (as the test
  suite passes) reached `fillTemplate` as `undefined` and threw. They now fall
  back to the built-in wording. The same class of bug silently disabled trimming
  when `trimRepeatedTail` was omitted; it now means "use the default".
- A firing whose rule implies a block type that is not open now logs a warning
  instead of skipping the trim silently.
- `README_EN.md` carried no fork notice while `README.md` did, so English
  readers could not tell the package was modified. Both now state the origin,
  the licence and the non-affiliation. Installation commands in both READMEs
  point at this fork's repository; the upstream attribution links are kept, as
  the MIT Licence requires.

## 1.0.4 and earlier

See the upstream project:
<https://github.com/MrWeiCodes/dsh-loop-guard>
