import { describe, expect, it, vi } from 'vitest';
import { createLogger, serializeError } from '../src/logger.js';

describe('logger', () => {
  it('redacts sensitive fields and serializes hostile values safely', () => {
    const sink = vi.fn();
    const log = createLogger(sink);
    const circular: Record<string, unknown> = { body: 'secret-body' };
    circular.self = circular;

    expect(() => {
      log.error('test message', {
        event: 'logger.test',
        password: 'super-secret',
        cookies: { session: 'abc' },
        payload: circular,
        count: BigInt(42),
      });
    }).not.toThrow();

    const [, line] = sink.mock.calls[0];
    const entry = JSON.parse(line);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.cookies).toBe('[REDACTED]');
    expect(entry.payload.body).toBe('[REDACTED]');
    expect(entry.payload.self).toBe('[Circular]');
    expect(entry.count).toBe('42');
  });

  it('serializes non-Error throwables without throwing', () => {
    const error = serializeError({ reason: 'boom', value: BigInt(7) });
    expect(error).toEqual({
      type: 'object',
      value: {
        reason: 'boom',
        value: '7',
      },
    });
  });
});
