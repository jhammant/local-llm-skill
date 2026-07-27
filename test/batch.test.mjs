import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch, substituteTemplate } from '../src/batch.mjs';

const endpoint = {
  id: 'test',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'none',
  capacityGb: null,
};

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function records(path) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const noTouch = async () => {};
const noSleep = async () => {};

test('template substitution replaces fields and names missing fields with the line', () => {
  assert.equal(
    substituteTemplate('Hello {{ name }}: {{count}}', { name: 'Ada', count: 3 }, 7),
    'Hello Ada: 3',
  );
  assert.throws(
    () => substituteTemplate('Hello {{missing}}', { name: 'Ada' }, 7),
    /Unknown template field "missing" on input line 7/,
  );
});

test('batch fails fast on a missing placeholder before calling the client', async (t) => {
  const directory = await temporaryDirectory(t);
  const out = join(directory, 'results.jsonl');
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      throw new Error('must not be called');
    },
  };

  await assert.rejects(
    runBatch({
      endpoint,
      model: 'test/model',
      template: '{{missing}}',
      items: [{ id: 'one', present: true }],
      out,
      concurrency: 1,
      client,
      sleep: noSleep,
      touchFn: noTouch,
    }),
    /Unknown template field "missing" on input line 1/,
  );
  assert.equal(calls, 0);
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});

test('resume skips ids already present in the output', async (t) => {
  const directory = await temporaryDirectory(t);
  const out = join(directory, 'results.jsonl');
  await writeFile(out, `${JSON.stringify({
    i: 0,
    id: 'done-id',
    ok: true,
    response: 'existing',
    usage: null,
    ms: 1,
    error: null,
  })}\n`);
  const calls = [];
  const client = {
    async chat(receivedEndpoint, request) {
      assert.equal(receivedEndpoint, endpoint);
      calls.push(request.messages.at(-1).content);
      return {
        message: { role: 'assistant', content: 'new response' },
        usage: { completion_tokens: 2 },
        ms: 4,
      };
    },
  };

  const result = await runBatch({
    endpoint,
    model: 'test/model',
    template: 'Process {{value}}',
    items: [
      { id: 'done-id', value: 'first' },
      { id: 'new-id', value: 'second' },
    ],
    out,
    concurrency: 1,
    client,
    sleep: noSleep,
    touchFn: noTouch,
  });

  assert.deepEqual(calls, ['Process second']);
  assert.equal(result.skipped, 1);
  assert.equal(result.done, 2);
  assert.deepEqual((await records(out)).map((record) => record.id), ['done-id', 'new-id']);
});

test('a failed item is recorded after two retries and the batch continues', async (t) => {
  const directory = await temporaryDirectory(t);
  const out = join(directory, 'results.jsonl');
  const attempts = new Map();
  const delays = [];
  const client = {
    async chat(_endpoint, request) {
      const prompt = request.messages.at(-1).content;
      attempts.set(prompt, (attempts.get(prompt) ?? 0) + 1);
      if (prompt === 'bad') throw new Error('deliberate failure');
      return {
        message: { role: 'assistant', content: `ok:${prompt}` },
        usage: { completion_tokens: 1 },
        ms: 2,
      };
    },
  };

  const result = await runBatch({
    endpoint,
    model: 'test/model',
    template: '{{value}}',
    items: [{ id: 'bad', value: 'bad' }, { id: 'good', value: 'good' }],
    out,
    concurrency: 1,
    client,
    sleep: async (ms) => delays.push(ms),
    touchFn: noTouch,
  });
  const output = await records(out);

  assert.equal(attempts.get('bad'), 3);
  assert.equal(attempts.get('good'), 1);
  assert.deepEqual(delays, [1_000, 4_000]);
  assert.equal(output[0].ok, false);
  assert.match(output[0].error, /deliberate failure/);
  assert.equal(output[1].ok, true);
  assert.equal(result.failed, 1);
  assert.equal(result.ok, 1);
});

test('worker pool never exceeds the requested concurrency cap', async (t) => {
  const directory = await temporaryDirectory(t);
  const out = join(directory, 'results.jsonl');
  let active = 0;
  let maximum = 0;
  const client = {
    async chat() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      active -= 1;
      return {
        message: { role: 'assistant', content: 'done' },
        usage: { completion_tokens: 1 },
        ms: 5,
      };
    },
  };

  await runBatch({
    endpoint,
    model: 'test/model',
    template: '{{value}}',
    items: Array.from({ length: 12 }, (_value, index) => ({ value: index })),
    out,
    concurrency: 3,
    client,
    sleep: noSleep,
    touchFn: noTouch,
  });

  assert.equal(maximum, 3);
  assert.equal((await records(out)).length, 12);
});

test('a burst endpoint refuses batch items without --allow-remote-data', async (t) => {
  const directory = await temporaryDirectory(t);
  const out = join(directory, 'results.jsonl');
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      return { message: { content: 'must not happen' } };
    },
  };

  await assert.rejects(
    runBatch({
      endpoint: {
        id: 'burst',
        kind: 'aiod',
        control: 'aiod',
        baseUrl: 'http://public-burst.test',
      },
      model: 'Qwen/test',
      template: '{{value}}',
      items: [{ value: 'private input' }],
      out,
      client,
      touchFn: noTouch,
    }),
    /--allow-remote-data/,
  );
  assert.equal(calls, 0);
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});
