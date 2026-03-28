---
name: typecheck
description: 'Audit and fix TypeScript type quality across hexbot — eliminates `any`, unsafe casts, and weak annotations; extracts reusable types. Use when the user wants to tighten types in a file, folder, or the whole codebase.'
argument-hint: "<target: file, folder, or 'all'>"
---

# Type Quality Auditor

Review and fix TypeScript type quality. This skill **reads, reports, and then fixes** — it doesn't just describe problems.

## Scope resolution

- **`all`** — every `.ts` file in `src/` and `plugins/`
- **`@file` or a path** — that file only
- **folder path** — all `.ts` files under that directory

If no argument is given, default to `all`.

## Step 1: Compile check

Run `pnpm tsc --noEmit` first and note any existing errors. These take priority — fix them before type improvements.

## Step 2: Read every file in scope

Read each file before touching it. Never guess at a shape — trace through the code to understand what a value actually is.

## Step 3: Audit for type issues

For each file, check every item below. Record file path and line number for each finding.

### `any` usage

- Explicit `any` in type annotations, return types, generics, or casts
- Implicit `any` from untyped parameters or return values
- `any[]` arrays that could be typed specifically
- Exception: third-party library types that genuinely cannot be typed — note these but don't force-type them

### Unsafe casts

- `as SomeType` where the cast is not proven safe by surrounding logic (e.g., casting an `unknown` network response without validation)
- Double casts (`as unknown as T`) used to silence errors rather than to bridge a genuine structural equivalence
- Non-null assertions (`!`) where the value could actually be null/undefined

### Weak or missing annotations

- Function parameters with no type annotation (TypeScript will infer `any` in strict mode)
- Return types omitted on public/exported functions
- Object literals typed as `{}` or `object` instead of a specific interface
- Callbacks with untyped parameters

### Reusability gaps

- The same shape defined inline in more than one place — extract to `src/types.ts` or the relevant module's interface block
- Types defined inside a function body that belong at module scope
- Plugin handler signatures that differ from the canonical types in `src/types.ts`

### Enum and union hygiene

- String literals used ad-hoc where a union type or const enum exists (or should exist)
- Loose `string` annotations where the actual values are a known set

## Step 4: Fix everything in scope

Apply fixes directly — don't just report. For each issue:

1. **Replace `any`** with the correct specific type. Trace the value to its origin if needed.
2. **Remove unsafe casts** — add runtime validation (type guards, `instanceof`, `in` checks) before the cast, or restructure to eliminate it.
3. **Remove double casts** — if `as unknown as T` is genuinely needed (e.g. test doubles), add a comment explaining why.
4. **Add missing annotations** — parameters, return types, exported function signatures.
5. **Extract shared types** — add the interface/type alias to `src/types.ts` (or a co-located types file for plugins), then import it in both places.
6. **Tighten loose annotations** — replace `object`, `{}`, or `Record<string, any>` with specific interfaces.

## Step 5: Re-run compile check

Run `pnpm tsc --noEmit` again after fixes. All changes must leave the project in a clean or better compile state — do not leave new errors.

## Output format

After all fixes are applied, report:

```
## Type Quality Report: <target>

### Compile status
Before: X errors / After: Y errors

### Fixed
- `path/to/file.ts:42` — replaced `any` with `PluginConfig` (extracted to src/types.ts)
- `path/to/file.ts:88` — removed unsafe `as Channel` cast; added `isChannel()` type guard
- ...

### Skipped (justified `any`)
- `path/to/file.ts:12` — `irc-framework` emits untyped event payloads; `any` here is unavoidable without patching upstream types

### Remaining compile errors (pre-existing, unrelated)
- ...
```

## Guidelines

- Prefer type guards and narrowing over casts — write an `isX(val): val is X` function when needed
- When a shape appears in multiple files, the canonical home is `src/types.ts` for core types and `plugins/<name>/types.ts` for plugin-local types
- Don't widen types to make a problem go away — if a type is `string | undefined` and the code assumes `string`, fix the null handling, not the annotation
- `unknown` is better than `any` for values whose type isn't yet established — it forces callers to narrow before use
- Don't add `@ts-ignore` or `@ts-expect-error` unless absolutely necessary and always with a comment explaining why
- Leave code behavior identical — this is a type-only pass

Target: $ARGUMENTS
