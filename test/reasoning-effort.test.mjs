import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask } from '../src/ask.mjs';
import { runBatch } from '../src/batch.mjs';
import { chat, validateReasoningEffort } from '../src/lmstudio.mjs';
import { planBatch } from '../src/plan.mjs';

const endpoint = {
  id: 'test',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'none',
  capacityGb: null,
};

const noTouch = async () => {};
const noSleep = async () => {};

function fakeFetch(captured) {
  return async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'yes' } }],
          usage: { completion_tokens: 3 },
        });
      },
    };
  };
}

test('chat body carries reasoning_effort only when the flag is set', async () => {
  const bodies = [];
  const fetchFn = fakeFetch(bodies);
  const base = { model: 'test/model', messages: [{ role: 'user', content: 'hi' }] };

  await chat(endpoint, { ...base, reasoningEffort: 'none' }, { fetchFn });
  assert.equal(bodies[0].reasoning_effort, 'none');

  await chat(endpoint, base, { fetchFn });
  assert.ok(
    !Object.hasOwn(bodies[1], 'reasoning_effort'),
    'reasoning_effort must be absent from the body when the flag is not passed',
  );
});

test('chat rejects an invalid reasoning effort and lists the valid options', async () => {
  const bodies = [];
  await assert.rejects(
    chat(endpoint, {
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'max',
    }, { fetchFn: fakeFetch(bodies) }),
    /Invalid reasoning effort "max"\. Valid options: none, low, medium, high/,
  );
  assert.equal(bodies.length, 0, 'an invalid effort must never reach the server');
  assert.throws(() => validateReasoningEffort(''), /Valid options: none, low, medium, high/);
});

test('ask forwards the reasoning effort to the client', async () => {
  const calls = [];
  const client = {
    async chat(_endpoint, request) {
      calls.push(request);
      return { message: { content: 'ok' }, usage: null, ms: 1 };
    },
  };
  const base = {
    endpoint,
    prompt: 'classify this',
    model: 'test/model',
    client,
    admitFn: async () => ({ ok: true }),
    touchFn: noTouch,
  };

  await ask({ ...base, reasoningEffort: 'low' });
  assert.equal(calls[0].reasoningEffort, 'low');

  await ask(base);
  assert.equal(calls[1].reasoningEffort, undefined);
});

test('batch forwards the reasoning effort to the client on every item', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-effort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const client = {
    async chat(_endpoint, request) {
      calls.push(request);
      return { message: { content: 'ok' }, usage: { completion_tokens: 2 }, ms: 1 };
    },
  };
  const base = {
    endpoint,
    model: 'test/model',
    template: 'Say: {{text}}',
    items: [{ text: 'a' }, { text: 'b' }],
    client,
    sleep: noSleep,
    touchFn: noTouch,
    concurrency: 1,
  };

  await runBatch({ ...base, out: join(directory, 'with.jsonl'), reasoningEffort: 'high' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((request) => request.reasoningEffort === 'high'));

  calls.length = 0;
  await runBatch({ ...base, out: join(directory, 'without.jsonl') });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((request) => request.reasoningEffort === undefined));
});

test('plan inherits the reasoning effort flag on both the sample and the probe', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-effort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const client = {
    async chat(_endpoint, request) {
      calls.push(request);
      return { message: { content: 'yes' }, usage: { completion_tokens: 3 } };
    },
  };
  const base = {
    endpoint,
    model: 'test/model',
    template: '{{text}}',
    items: Array.from({ length: 10 }, () => ({ text: 'aaaa' })),
    throughputPath: join(directory, 'throughput.json'),
    client,
  };

  await planBatch({ ...base, reasoningEffort: 'none' });
  assert.equal(calls.length, 8, 'default sample runs 8 items end-to-end');
  assert.ok(
    calls.every((request) => request.reasoningEffort === 'none'),
    'every sample request must carry the effort the real run will use',
  );

  calls.length = 0;
  await planBatch({ ...base, sample: false, reasoningEffort: 'high' });
  assert.equal(calls.length, 3, 'the fallback probe samples 3 items');
  assert.ok(
    calls.every((request) => request.reasoningEffort === 'high'),
    'every probe request must carry the effort the real run will use',
  );

  calls.length = 0;
  await planBatch(base);
  assert.ok(calls.every((request) => request.reasoningEffort === undefined));
});
