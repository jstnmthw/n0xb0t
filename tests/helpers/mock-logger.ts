// Shared mock Logger for tests.
// Logger is a class with private members, so a plain object can't satisfy
// the type without a cast. This helper centralizes that single cast.
import { vi } from 'vitest';

import type { Logger } from '../../src/logger';

/**
 * Create a mock Logger where every method is a vi.fn() stub.
 * `child()` returns the same mock instance by default (self-referential).
 *
 * The `as unknown as Logger` cast is required because Logger is a class
 * with private fields that a plain object cannot structurally satisfy.
 */
export function createMockLogger(): Logger {
  const mock: Record<string, ReturnType<typeof vi.fn>> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn().mockReturnValue('info'),
  };
  mock.child.mockReturnValue(mock);
  // Test double: satisfies Logger's public API
  return mock as unknown as Logger;
}
