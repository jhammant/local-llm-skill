import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  installInterruptHandlers,
  selectOverflowEndpoint,
} from '../src/cli.mjs';
import { runWithTeardown } from '../src/aiod.mjs';

test('--overflow burst stays local when the local model is admissible', async () => {
  const local = {
    id: 'local',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234',
  };
  let burstLookups = 0;
  const selected = await selectOverflowEndpoint({
    endpoint: local,
    model: 'local/model',
    overflow: 'burst',
    admitFn: async () => ({
      ok: true,
      action: 'already-loaded',
      reason: 'fits locally',
    }),
    burstEndpointFn: async () => {
      burstLookups += 1;
      throw new Error('burst must not be consulted');
    },
  });

  assert.equal(selected.endpoint, local);
  assert.equal(selected.model, 'local/model');
  assert.equal(selected.overflowed, false);
  assert.equal(burstLookups, 0);
});

test('a synthetic SIGINT aborts the run and teardown still fires from finally', async () => {
  const signals = new EventEmitter();
  const controller = new AbortController();
  const interrupts = installInterruptHandlers(controller, signals);
  let teardownCalls = 0;
  try {
    await assert.rejects(
      runWithTeardown(
        async () => {
          signals.emit('SIGINT');
          assert.equal(controller.signal.aborted, true);
          throw new Error('run interrupted');
        },
        {
          teardownFn: async () => {
            teardownCalls += 1;
          },
        },
      ),
      /run interrupted/,
    );
  } finally {
    interrupts.remove();
  }
  assert.equal(interrupts.signal, 'SIGINT');
  assert.equal(teardownCalls, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
