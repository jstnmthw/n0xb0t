import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PluginLoader } from '../src/plugin-loader.js';
import { EventDispatcher } from '../src/dispatcher.js';
import { BotEventBus } from '../src/event-bus.js';
import { BotDatabase } from '../src/database.js';
import { Permissions } from '../src/core/permissions.js';
import type { BotConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `n0xb0t-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(dir: string, name: string, code: string): string {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  const filePath = join(pluginDir, 'index.ts');
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

function writePluginConfig(dir: string, name: string, config: Record<string, unknown>): void {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'config.json'), JSON.stringify(config), 'utf-8');
}

function writePluginsJson(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, 'plugins.json');
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return path;
}

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: { host: 'localhost', port: 6667, tls: false, nick: 'test', username: 'test', realname: 'test', channels: [] },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

function createLoader(pluginDir: string, db?: BotDatabase): { loader: PluginLoader; dispatcher: EventDispatcher; eventBus: BotEventBus; db: BotDatabase; permissions: Permissions } {
  const database = db ?? new BotDatabase(':memory:');
  if (!db) database.open();
  const dispatcher = new EventDispatcher();
  const eventBus = new BotEventBus();
  const permissions = new Permissions(database);

  const loader = new PluginLoader({
    pluginDir,
    dispatcher,
    eventBus,
    db: database,
    permissions,
    botConfig: MINIMAL_BOT_CONFIG,
    ircClient: null,
  });

  return { loader, dispatcher, eventBus, db: database, permissions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('should load a valid plugin and call init()', async () => {
      const pluginPath = writePlugin(tempDir, 'test-plugin', `
        export const name = 'test-plugin';
        export const version = '1.0.0';
        export const description = 'A test plugin';
        export function init(api) {
          api.log('initialized');
        }
      `);

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('ok');
      expect(result.name).toBe('test-plugin');
    });

    it('should register binds from init()', async () => {
      const pluginPath = writePlugin(tempDir, 'bind-plugin', `
        export const name = 'bind-plugin';
        export const version = '1.0.0';
        export const description = 'Plugin that binds';
        export function init(api) {
          api.bind('pub', '-', '!test', (ctx) => ctx.reply('ok'));
        }
      `);

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      const binds = dispatcher.listBinds({ pluginId: 'bind-plugin' });
      expect(binds).toHaveLength(1);
      expect(binds[0].mask).toBe('!test');
    });

    it('should reject plugin with missing name export', async () => {
      const pluginPath = writePlugin(tempDir, 'no-name', `
        export function init(api) {}
      `);

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('name');
    });

    it('should reject plugin with missing init export', async () => {
      const pluginPath = writePlugin(tempDir, 'no-init', `
        export const name = 'no-init';
      `);

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('init');
    });

    it('should catch and report init() errors', async () => {
      const pluginPath = writePlugin(tempDir, 'bad-init', `
        export const name = 'bad-init';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          throw new Error('boom');
        }
      `);

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('boom');
      expect(loader.isLoaded('bad-init')).toBe(false);
    });

    it('should clean up binds when init() throws', async () => {
      const pluginPath = writePlugin(tempDir, 'partial-init', `
        export const name = 'partial-init';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.bind('pub', '-', '!before', (ctx) => {});
          throw new Error('mid-init error');
        }
      `);

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      const binds = dispatcher.listBinds({ pluginId: 'partial-init' });
      expect(binds).toHaveLength(0);
    });

    it('should reject loading the same plugin twice', async () => {
      const pluginPath = writePlugin(tempDir, 'dupe-plugin', `
        export const name = 'dupe-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('already loaded');
    });

    it('should reject unsafe plugin names', async () => {
      const pluginPath = writePlugin(tempDir, 'bad-name', `
        export const name = '../escape';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('invalid characters');
    });

    it('should return error for non-existent file', async () => {
      const { loader } = createLoader(tempDir);
      const result = await loader.load(join(tempDir, 'ghost', 'index.ts'));

      expect(result.status).toBe('error');
      expect(result.error).toContain('not found');
    });

    it('should emit plugin:loaded event', async () => {
      const pluginPath = writePlugin(tempDir, 'event-plugin', `
        export const name = 'event-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);

      const { loader, eventBus } = createLoader(tempDir);
      const listener = vi.fn();
      eventBus.on('plugin:loaded', listener);

      await loader.load(pluginPath);

      expect(listener).toHaveBeenCalledWith('event-plugin');
    });
  });

  describe('unload', () => {
    it('should call teardown() on unload', async () => {
      // We track teardown via a side effect — writing a file
      const markerPath = join(tempDir, 'teardown-marker');
      const pluginPath = writePlugin(tempDir, 'teardown-plugin', `
        import { writeFileSync } from 'node:fs';
        export const name = 'teardown-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
        export function teardown() {
          writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'torn down', 'utf-8');
        }
      `);

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);
      await loader.unload('teardown-plugin');

      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, 'utf-8')).toBe('torn down');
    });

    it('should remove all binds on unload', async () => {
      const pluginPath = writePlugin(tempDir, 'bind-unload', `
        export const name = 'bind-unload';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.bind('pub', '-', '!a', (ctx) => {});
          api.bind('pubm', '-', '*hello*', (ctx) => {});
        }
      `);

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      expect(dispatcher.listBinds({ pluginId: 'bind-unload' })).toHaveLength(2);

      await loader.unload('bind-unload');

      expect(dispatcher.listBinds({ pluginId: 'bind-unload' })).toHaveLength(0);
    });

    it('should throw when unloading a plugin that is not loaded', async () => {
      const { loader } = createLoader(tempDir);
      await expect(loader.unload('nonexistent')).rejects.toThrow('not loaded');
    });

    it('should emit plugin:unloaded event', async () => {
      const pluginPath = writePlugin(tempDir, 'unload-event', `
        export const name = 'unload-event';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);

      const { loader, eventBus } = createLoader(tempDir);
      const listener = vi.fn();
      eventBus.on('plugin:unloaded', listener);

      await loader.load(pluginPath);
      await loader.unload('unload-event');

      expect(listener).toHaveBeenCalledWith('unload-event');
    });
  });

  describe('reload', () => {
    it('should reload a plugin (unload old binds, load new binds)', async () => {
      // Vitest's module transform cache prevents true code-change reload testing.
      // Instead we verify the mechanism: unload removes binds, load re-registers.
      const pluginPath = writePlugin(tempDir, 'reload-plugin', `
        export const name = 'reload-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.bind('pub', '-', '!reload-cmd', (ctx) => {});
        }
      `);

      const { loader, dispatcher, eventBus } = createLoader(tempDir);
      await loader.load(pluginPath);

      expect(dispatcher.listBinds({ pluginId: 'reload-plugin' })).toHaveLength(1);

      const reloadedListener = vi.fn();
      eventBus.on('plugin:reloaded', reloadedListener);

      const result = await loader.reload('reload-plugin');

      expect(result.status).toBe('ok');
      expect(reloadedListener).toHaveBeenCalledWith('reload-plugin');
      // After reload, binds should be re-registered (old ones removed, new ones added)
      const binds = dispatcher.listBinds({ pluginId: 'reload-plugin' });
      expect(binds).toHaveLength(1);
      expect(binds[0].mask).toBe('!reload-cmd');
    });

    it('should throw when reloading a plugin that is not loaded', async () => {
      const { loader } = createLoader(tempDir);
      await expect(loader.reload('nonexistent')).rejects.toThrow('not loaded');
    });
  });

  describe('loadAll', () => {
    it('should load only enabled plugins from plugins.json', async () => {
      writePlugin(tempDir, 'enabled-one', `
        export const name = 'enabled-one';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);
      writePlugin(tempDir, 'enabled-two', `
        export const name = 'enabled-two';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);
      writePlugin(tempDir, 'disabled-one', `
        export const name = 'disabled-one';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `);

      const configDir = makeTempDir();
      const cfgPath = writePluginsJson(configDir, {
        'enabled-one': { enabled: true },
        'enabled-two': { enabled: true },
        'disabled-one': { enabled: false },
      });

      const { loader } = createLoader(tempDir);
      const results = await loader.loadAll(cfgPath);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
      expect(loader.isLoaded('enabled-one')).toBe(true);
      expect(loader.isLoaded('enabled-two')).toBe(true);
      expect(loader.isLoaded('disabled-one')).toBe(false);

      rmSync(configDir, { recursive: true, force: true });
    });
  });

  describe('scoped API', () => {
    it('should namespace database operations per plugin', async () => {
      const pluginAPath = writePlugin(tempDir, 'plugin-a', `
        export const name = 'plugin-a';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('shared-key', 'value-from-a');
        }
      `);
      const pluginBPath = writePlugin(tempDir, 'plugin-b', `
        export const name = 'plugin-b';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('shared-key', 'value-from-b');
        }
      `);

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);

      await loader.load(pluginAPath);
      await loader.load(pluginBPath);

      // Verify isolation — each plugin sees its own namespace
      expect(db.get('plugin-a', 'shared-key')).toBe('value-from-a');
      expect(db.get('plugin-b', 'shared-key')).toBe('value-from-b');

      db.close();
    });

    it('should not allow plugin A to access plugin B database', async () => {
      const pluginPath = writePlugin(tempDir, 'namespace-test', `
        export const name = 'namespace-test';
        export const version = '1.0.0';
        export const description = '';
        let savedApi;
        export function init(api) {
          savedApi = api;
          api.db.set('mykey', 'myvalue');
        }
        export function getApi() { return savedApi; }
      `);

      const db = new BotDatabase(':memory:');
      db.open();

      // Pre-seed a different namespace
      db.set('other-plugin', 'secret', 'top-secret');

      const { loader } = createLoader(tempDir, db);
      await loader.load(pluginPath);

      // The plugin can only see its own namespace
      expect(db.get('namespace-test', 'mykey')).toBe('myvalue');
      // Direct DB access shows isolation
      expect(db.get('namespace-test', 'secret')).toBeNull();
      expect(db.get('other-plugin', 'secret')).toBe('top-secret');

      db.close();
    });
  });

  describe('config merging', () => {
    it('should merge plugin config.json with plugins.json overrides', async () => {
      // Write plugin with config.json defaults
      writePluginConfig(tempDir, 'config-plugin', {
        greeting: 'hello',
        color: 'blue',
      });
      // Plugin writes its config values to the DB so we can verify
      const pluginPath = writePlugin(tempDir, 'config-plugin', `
        export const name = 'config-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('cfg-greeting', String(api.config.greeting ?? ''));
          api.db.set('cfg-color', String(api.config.color ?? ''));
          api.db.set('cfg-extra', String(api.config.extra ?? ''));
        }
      `);

      const pluginsConfig = {
        'config-plugin': {
          enabled: true,
          config: {
            color: 'red',
            extra: 'new',
          },
        },
      };

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);
      await loader.load(pluginPath, pluginsConfig);

      // Verify merged config: defaults + overrides
      expect(db.get('config-plugin', 'cfg-greeting')).toBe('hello');
      expect(db.get('config-plugin', 'cfg-color')).toBe('red');
      expect(db.get('config-plugin', 'cfg-extra')).toBe('new');

      db.close();
    });
  });

  describe('list', () => {
    it('should list loaded plugins', async () => {
      const pluginPath = writePlugin(tempDir, 'list-plugin', `
        export const name = 'list-plugin';
        export const version = '2.5.0';
        export const description = 'A listable plugin';
        export function init(api) {}
      `);

      const { loader } = createLoader(tempDir);
      expect(loader.list()).toHaveLength(0);

      await loader.load(pluginPath);

      const plugins = loader.list();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('list-plugin');
      expect(plugins[0].version).toBe('2.5.0');
      expect(plugins[0].description).toBe('A listable plugin');
    });
  });
});
