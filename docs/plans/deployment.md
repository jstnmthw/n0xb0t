# Plan: Deployment and Distribution

## Summary

Single distribution track: **clone the repo, configure, `docker compose up`**. Docker Compose mounts the source tree into a Node container and runs the bot with `tsx`. No image registry, no compiled artifacts, no plugin seeding — the container is just a runtime wrapper. Plugins live on the host filesystem and can be edited/reloaded without rebuilding anything.

---

## Feasibility

- **Alignment:** No design changes needed. `pnpm start` already works via `tsx`. `--config <path>` works. Hot-reload works.
- **Dependencies:** All existing — nothing new to build.
- **Blockers:** `better-sqlite3` native addon must be compiled inside the container (never copy `node_modules` from host). The container runs `pnpm install` at startup or build time to get the correct binary.
- **Complexity:** S. A Dockerfile, a compose file, and one code fix.
- **Risk:** Low. The container is just running `pnpm start` — same as local dev.

---

## Dependencies

- [x] `src/index.ts` — SIGTERM/SIGINT handled
- [x] `--config <path>` CLI flag working
- [x] `data/` directory auto-creation (currently fails if missing)

---

## Decisions

1. **No image registry.** Users clone the repo and build locally. No ghcr.io, no published images.
2. **No compiled JS in production.** The container uses `tsx` to run TypeScript directly — same as development. A `build`/`start:prod` script pair is added for users who want compiled output outside Docker, but Docker uses `tsx`.
3. **Volume mounts for user state.** `config/`, `plugins/`, and `data/` are bind-mounted from the host. Users edit files on the host; the bot sees changes immediately (plugins via hot-reload, config on restart).
4. **No plugin seeding or bundled-plugins.** Plugins live in `plugins/` on the host, mounted into the container as-is. Users manage their own plugin directory.
5. **No systemd docs.** Out of scope for now — Docker is the supported "always on" path.
6. **tsconfig rootDir:** Leave as-is. Not relevant since Docker runs via `tsx`, not compiled output.

---

## Phases

### Phase 1: Code fix — auto-create `data/`

**Goal:** The bot creates the `data/` directory on startup if it doesn't exist, so a fresh clone doesn't fail.

- [x] In `src/bot.ts` constructor, `mkdirSync(dirname(resolvedDbPath), { recursive: true })` before passing path to `BotDatabase`
- [x] **Verify:** Delete `data/`, run `pnpm start` — bot creates the directory and starts normally

---

### Phase 2: Package scripts

**Goal:** Add `build` and `start:prod` for non-Docker production use.

- [x] Add `"build": "tsc"` to `package.json` scripts
- [x] Add `"start:prod": "node dist/src/index.js"` to `package.json` scripts
- [x] **Verify:** `pnpm build && pnpm start:prod --config config/bot.json` starts the bot

---

### Phase 3: Dockerfile + Compose

**Goal:** `docker compose up` builds the image and starts the bot with mounted config, plugins, and data.

- [x] Create `.dockerignore`:

  ```
  node_modules
  dist
  data
  config/bot.json
  config/plugins.json
  coverage
  .claude
  .git
  *.log
  *.db
  ```

- [x] Create `Dockerfile`:

  ```dockerfile
  FROM node:20-alpine

  WORKDIR /app

  # Install pnpm
  RUN corepack enable

  # Install dependencies (including native better-sqlite3 for Alpine)
  COPY package.json pnpm-lock.yaml ./
  RUN pnpm install --frozen-lockfile

  # Copy source (plugins/config/data come from volume mounts)
  COPY tsconfig.json ./
  COPY src/ ./src/
  COPY types/ ./types/

  CMD ["pnpm", "start"]
  ```

  Notes:
  - Single stage — no compilation step needed since we run via `tsx`.
  - `plugins/`, `config/`, and `data/` are volume-mounted at runtime, not baked in.
  - `node_modules` is built inside the container, so `better-sqlite3` gets the correct native binary.

- [x] Create `docker-compose.yml`:

  ```yaml
  services:
    hexbot:
      build: .
      restart: unless-stopped
      volumes:
        - ./config:/app/config
        - ./plugins:/app/plugins
        - ./data:/app/data
  ```

- [x] **Verify:** `docker compose up --build` starts the bot. Editing a plugin on the host and running `.reload <plugin>` in IRC picks up changes.

---

### Phase 4: GitHub Actions CI

**Goal:** CI runs lint, typecheck, and tests on every PR.

- [x] Create `.github/workflows/ci.yml`:
  - Trigger: `push` to any branch, `pull_request` to `main`
  - Job `test`:
    - `actions/checkout`
    - `actions/setup-node` (Node 20)
    - `pnpm/action-setup`
    - `pnpm install --frozen-lockfile`
    - `pnpm typecheck`
    - `pnpm lint`
    - `pnpm test`

- [x] **Verify:** Push a branch, confirm CI runs and passes.

---

### Phase 5: README update

**Goal:** README documents the Docker quickstart.

- [x] Add "Deploy with Docker" section to `README.md`:
  1. Clone the repo
  2. `cp config/bot.example.json config/bot.json` — edit server, nick, owner
  3. `cp config/plugins.example.json config/plugins.json` — edit as needed
  4. `docker compose up -d`
  5. `docker compose logs -f`
- [x] Clarify that `pnpm start` = tsx (dev), `pnpm start:prod` = compiled JS (optional)

- [x] **Verify:** README renders cleanly on GitHub.

---

## Config changes

None. `bot.example.json` works as-is — `"pluginDir": "./plugins"` resolves correctly inside the container because it's volume-mounted to the same relative path.

---

## Database changes

None. The `data/` auto-creation in Phase 1 is a `mkdirSync` call, not a schema change.

---

## Test plan

No new automated tests — this is infrastructure (Dockerfile, YAML, docs). Manual verification steps are in each phase.

CI (Phase 4) runs the existing test suite on every PR.
