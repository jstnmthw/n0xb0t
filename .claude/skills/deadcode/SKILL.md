---
name: deadcode
description: 'Find and remove dead/unused code in hexbot — unused exports, unreachable branches, commented-out blocks, and stale imports. Audits then deletes with user confirmation.'
argument-hint: '[path or blank for full scan]'
---

# Dead Code Eliminator

Find and remove unused code from the hexbot codebase. This skill **audits first, presents findings, then deletes** — it does not remove anything without presenting the full list first.

## Scope

If `$ARGUMENTS` is provided, limit the scan to that path. Otherwise scan all of:

- `src/` — core modules
- `plugins/` — all plugin directories
- `tests/` — unused test helpers only (do not remove tests themselves)

Skip: `node_modules/`, `dist/`, `*.json`, `*.md`, generated files.

## Phase 1: Compiler-detected unused code

Run the TypeScript compiler with stricter unused-code flags than the project's tsconfig enables by default:

```
pnpm tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1
```

Record every diagnostic. Group by file. These are high-confidence findings — the compiler proves they are unused.

Common patterns found this way:

- Local variables declared but never read
- Function parameters declared but never referenced
- Imports brought in but not used (TypeScript catches these in strict mode already, but `--noUnusedLocals` catches more)
- Destructured bindings with unused members

## Phase 2: Unused exports

Exported symbols that are **never imported** anywhere in the codebase are candidates for removal. To find them:

1. Glob all `*.ts` files in scope.
2. For each file, extract every `export` — functions, classes, consts, interfaces, types.
3. For each exported name, grep the entire codebase for imports of that name.
4. Flag any export with zero import sites **outside its own file**.

**Be conservative here.** Do not flag:

- Anything in `src/types.ts` — these are the public API types
- Plugin `init`, `teardown`, and `metadata` exports — consumed dynamically by the plugin loader
- Anything re-exported in an index file
- Anything whose name appears in a `// @public` comment
- Type-only exports used only in `.d.ts` or tests (these are intentional)

## Phase 3: Unreachable code

Search for code that can never execute:

1. **After unconditional control flow**: code following `return`, `throw`, `break`, or `continue` at the same nesting level within the same block. Look for non-blank, non-comment lines after these statements before the closing `}`.
2. **Always-false conditions**: `if (false)`, `if (0)`, `while (false)`, `if (process.env.NODE_ENV === 'never')`.
3. **Empty blocks that serve no purpose**: `catch (e) {}` with no body (suppresses errors silently — flag as dead unless there's an explicit comment saying it's intentional), empty `finally {}`, empty `else {}`.

## Phase 4: Commented-out code

Find large commented-out code blocks — not inline explanatory comments, but code that has been disabled:

- Blocks of 3+ consecutive lines that are all `//`-prefixed and contain code-like syntax (assignments, function calls, brackets)
- `/* ... */` blocks spanning 5+ lines that contain code

**Do not flag**:

- JSDoc / TSDoc comment blocks (`/** ... */`)
- Single-line explanatory comments
- `// TODO`, `// FIXME`, `// HACK`, `// NOTE` lines
- License headers

## Phase 5: Stale imports

Find imports that are brought in but whose symbols are never referenced in the file:

- `import { Foo } from './foo'` where `Foo` never appears in the file body
- `import * as ns from './ns'` where `ns` is never used
- Side-effect imports (`import './foo'`) are intentional — skip these

Note: TypeScript's own error `TS6133: 'X' is declared but its value is never read` covers most of this. Phase 5 is a cross-check.

## Phase 6: Hexbot-specific dead patterns

Check for patterns specific to this codebase that indicate orphaned work:

- **Bind registrations with no handler body** — `api.bind(...)` calls where the handler is `() => {}` or `async () => {}`
- **Plugin config fields declared in the type but never read** — grep for each field name in the config interface against the plugin source
- **Event bus listeners registered in `init` but not removed in `teardown`** — potential leak AND dead listener
- **Database table references** — SQL strings referencing table names that don't exist in `database.ts` schema
- **Capability declarations** — IRCv3 CAP strings listed in config that have no corresponding handler registered

## Process

1. Run Phase 1 (compiler check) — collect output.
2. Run Phases 2–6 (pattern analysis) — read files, search for patterns.
3. **Compile the full findings list** — deduplicate, group by file, assign confidence:
   - **High** — compiler-proven or definitively unreachable
   - **Medium** — export with no discovered import site (could be used dynamically)
   - **Low** — heuristic (commented code, stale-looking imports)
4. **Present the full findings list to the user** in the output format below. Stop and wait for confirmation.
5. After the user approves (or approves a subset), make the deletions.
6. Run `pnpm tsc --noEmit` to confirm the project still compiles cleanly.
7. Run `pnpm test` to confirm no tests broke.
8. Report what was removed.

## Output format (findings report)

```
## Dead Code Report — hexbot

_Scanned: <N> files | Date: <today>_

### High Confidence — safe to remove

| File | Line | Finding | Type |
|------|------|---------|------|
| src/foo.ts | 42 | `oldHelper` declared, never used | unused local |
| src/bar.ts | 88–95 | unreachable code after `return` | unreachable |

### Medium Confidence — review before removing

| File | Line | Finding | Type |
|------|------|---------|------|
| src/baz.ts | 12 | `export function legacyFn` — 0 import sites found | unused export |

### Low Confidence — judgment call

| File | Lines | Finding |
|------|-------|---------|
| plugins/seen/index.ts | 55–62 | commented-out block (8 lines) |

---

Total: X high / Y medium / Z low

Shall I remove all high-confidence findings? (You can approve all, approve by category, or list specific lines to skip.)
```

## Deletion rules

When removing dead code:

- **Unused imports**: remove the entire import line, or just the named binding if others in the same import are used.
- **Unused locals/parameters**: remove the declaration. If a parameter must be kept for signature compatibility (e.g., a callback), replace with `_paramName` convention.
- **Unused exports**: remove the `export` keyword first. If the symbol itself is also unused internally, remove the declaration entirely.
- **Unreachable blocks**: remove the unreachable lines. Do not remove the control-flow statement that makes them unreachable.
- **Commented-out code**: remove the entire commented block. Do not remove surrounding blank lines if they aid readability.
- **Empty catch blocks**: if truly empty and the error is legitimately ignorable, replace with `catch { /* intentional no-op */ }` and leave a comment. If the error should NOT be silently swallowed, escalate to the user.

## Guidelines

- **Never remove** plugin `init`, `teardown`, `metadata` exports — the plugin loader requires them.
- **Never remove** anything from `src/types.ts` without checking all import sites across the full project, including tests.
- If a "dead" symbol has a TODO comment referencing a planned feature, flag it but **do not remove** — ask the user.
- Prefer removing the whole dead unit (function + its import) over leaving an orphaned import.
- After removals, if a file becomes empty or has only imports remaining, remove the file entirely and clean up its import sites.
- Do not reformat or restructure surrounding code — this is a deletion-only pass.

Target: $ARGUMENTS
