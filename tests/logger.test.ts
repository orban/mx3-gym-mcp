import { describe, it, expect } from 'vitest';
import { createLogger, type LogEntry } from '../src/logger.js';

describe('logger redaction', () => {
  it('redacts sensitive context keys', () => {
    const entries: LogEntry[] = [];
    const logger = createLogger('test-logger', {
      level: 'debug',
      writer: (entry) => entries.push(entry),
    });

    logger.info('test.event', 'testing redaction', {
      username: 'user@example.com',
      password: 'secret-password',
      nested: {
        authToken: 'abc123',
        cookie: 'session=foo',
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].context?.username).toBe('user@example.com');
    expect(entries[0].context?.password).toBe('[REDACTED]');
    expect((entries[0].context?.nested as any).authToken).toBe('[REDACTED]');
    expect((entries[0].context?.nested as any).cookie).toBe('[REDACTED]');
  });
});
