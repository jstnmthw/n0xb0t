---
name: quality
description: 'Scan the hexbot codebase for god classes, mixed concerns, duplication, and readability problems. Produces a prioritized refactoring report. Does NOT write code.'
argument-hint: '[path or blank for full scan]'
---

# Quality Auditor

Scan source files for structural problems that hurt readability and maintainability. Produce a prioritized report. **Do not write any code** — this skill is analysis only. The user decides what to act on.

## Guiding principle

Readability and simplicity win. A slightly longer but obvious function beats a clever abstraction. Flag complexity that makes the code harder to reason about for a human reading it cold. Do NOT flag things just because a style guide says so — flag them because a reader would genuinely struggle.

## Scan targets

If `$ARGUMENTS` is provided, limit the scan to that path. Otherwise scan:

- `src/` — all core modules
- `plugins/` — all plugin directories
- `tests/` — flag test files only if they have structural problems (e.g., 500-line test files with no grouping)

Skip: `node_modules/`, `dist/`, `*.json`, `*.md`, generated files.

## What to look for

### God files / God classes

A file is a god file when it owns too many unrelated responsibilities. Signal: you cannot describe what it does in one sentence without using "and" more than once. Look for:

- Files over ~250 lines that mix concerns (I/O + business logic + state management)
- Classes or objects with more than ~8 methods spanning unrelated domains
- Modules that are imported by nearly everything (high fan-in without being a genuine utility)

### Mixed concerns

A single function or block doing more than one job:

- Parsing input AND executing side effects AND formatting output in the same function
- State mutation interleaved with pure computation
- Network I/O mixed with permission checking mixed with database writes
- Plugin init functions that contain large blocks of inline logic that could be named helpers

### Duplication

Look for near-identical patterns repeated across files:

- Copy-pasted permission checks
- Similar command handler skeletons with slightly different logic
- The same data shape built in multiple places without a shared constructor
- Repeated error message strings

### Readability problems

- Functions longer than ~40 lines with no named sub-steps
- Deep nesting (3+ levels of if/for/try without extraction)
- Variables named `data`, `result`, `tmp`, `obj`, `item` without context
- Boolean parameters that require reading the implementation to understand (`doThing(true, false, true)`)
- Implicit state dependencies where a function's behavior depends on external state not visible in its signature

### Over-engineering signals

Flag these too — premature abstraction is as bad as duplication:

- Abstractions used only once
- Interfaces with a single implementor and no near-term second use
- Factory functions wrapping a single `new`
- Event indirection where a direct call would be clearer

### Hexbot-specific patterns

- Plugins importing directly from `src/` (API boundary violation — must use the `api` object only)
- State that should be in `channel-state.ts` scattered across plugin files
- Command handlers doing permission logic inline instead of relying on bind flags
- Teardown functions that don't clean up all resources registered in init

## Process

1. **Glob all target files** — get the full file list
2. **Read each file** — do not skim; read the actual content
3. **Score each file** on: size, concern count, duplication signals, nesting depth, naming clarity
4. **Rank by refactoring value** — high value = would meaningfully improve readability, low risk = behavior-preserving split is straightforward
5. **Write the report** in the format below

## Output format

```markdown
# Quality Report — hexbot

_Scanned: <file count> files across src/, plugins/, tests/_
_Date: <today>_

## Summary

<2-4 sentences: overall health, biggest systemic issue, one encouraging thing>

## High Priority

Issues where refactoring would most improve readability or reduce risk.

### [File path] — <one-line problem statement>

**Problem:** <what is wrong and why it hurts readability>
**Evidence:** <specific line ranges or function names>
**Suggested split:** <concrete proposal — e.g., "extract X into its own module", "break `handleJoin` into `verifyIdentity` + `applyModes`">
**Risk:** Low / Medium (is the behavior easy to preserve?)

---

## Medium Priority

Worth doing, not urgent.

### [File path] — <one-line problem statement>

...

---

## Low Priority / Cosmetic

Small wins, address opportunistically.

- `path/to/file.ts` line N — <brief note>
- ...

---

## Patterns to address across the codebase

<Systemic issues that appear in multiple files — address these with a single coordinated change rather than file-by-file>

---

## What looks good

<Be specific. Call out files or patterns that are clean and worth emulating. This is not filler — it tells the user what NOT to change.>
```

## Guidelines

- Quote specific line numbers or function names — vague observations are useless
- One finding per finding — don't bundle unrelated issues into one entry
- If a file is genuinely clean, say so and move on; do not manufacture findings
- Prioritize by reader impact, not by rule count
- Do not suggest splitting a file just because it's long — a 300-line file with a single clear concern is fine
- If a refactor would require changing the plugin API contract, flag that explicitly as a breaking change

Target: $ARGUMENTS
