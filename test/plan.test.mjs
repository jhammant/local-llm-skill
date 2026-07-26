import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateEtaSeconds,
  estimateTokens,
  planBatch,
  sampleItems,
  samplePromptTokens,
} from '../src/plan.mjs';

const endpoint = {
  id: 'local',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
};

test('ETA regression: 8 items in 3.5s over 5000 items is ~2190s, not ~547s', () => {
  // itemsPerSec = itemsCompleted / wallClockSeconds already includes
  // concurrency. Dividing by the slot count again would claim ~547s — the bug
  // this test pins against.
  const { itemsPerSec, remainingItems, etaSeconds } = estimateEtaSeconds({
    totalItems: 5000,
    itemsCompleted: 8,
    wallClockSeconds: 3.5,
  });
  assert.ok(Math.abs(itemsPerSec - 8 / 3.5) < 1e-9);
  assert.equal(remainingItems, 4992);
  assert.ok(etaSeconds > 2100 && etaSeconds < 2300, `eta ${etaSeconds} should be ~2190s`);
  assert.ok(etaSeconds > 1000, 'ETA must not be divided by the slot count again');
});

test('estimateEtaSeconds validates its inputs', () => {
  assert.throws(
    () => estimateEtaSeconds({ totalItems: 10, itemsCompleted: 0, wallClockSeconds: 1 }),
    /itemsCompleted/,
  );
  assert.throws(
    () => estimateEtaSeconds({ totalItems: 10, itemsCompleted: 1, wallClockSeconds: 0 }),
    /wallClockSeconds/,
  );
});

test('estimateTokens uses the chars/4 heuristic', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('sampleItems returns everything below the cap and strides above it', () => {
  const few = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(sampleItems(few, 20), few);

  const many = Array.from({ length: 100 }, (_v, index) => ({ index }));
  const sample = sampleItems(many, 10);
  assert.equal(sample.length, 10);
  assert.equal(sample[0].index, 0);
  assert.equal(sample[9].index, 90);
});

test('samplePromptTokens substitutes the template and averages', () => {
  const items = [
    { text: 'aaaa' },
    { text: 'aaaaaaaa' },
  ];
  // "Say: aaaa" is 9 chars -> 3 tokens; "Say: aaaaaaaa" is 13 chars -> 4 tokens.
  const result = samplePromptTokens(items, 'Say: {{text}}');
  assert.equal(result.sampled, 2);
  assert.equal(result.promptTokensPerItem, 3.5);
  assert.match(result.source, /assumed/);
});

test('samplePromptTokens fails fast on an unknown template field', () => {
  assert.throws(
    () => samplePromptTokens([{ text: 'hi' }], 'Say: {{missing}}'),
    /Unknown template field "missing"/,
  );
});

test('planBatch labels an unmeasured rate as assumed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = await planBatch({
    endpoint,
    model: 'never-benched-model',
    template: 'Say: {{text}}',
    items: Array.from({ length: 40 }, () => ({ text: 'some input text' })),
    throughputPath: join(directory, 'throughput.json'),
    probe: false,
  });
  assert.equal(plan.items, 40);
  assert.equal(plan.rate.measured, false);
  assert.match(plan.rate.source, /assumed/);
  assert.ok(plan.etaSeconds > 0);
});

test('planBatch uses a measured rate from the throughput cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');
  await writeFile(throughputPath, JSON.stringify({
    'local/qwen3-coder-next': {
      endpoint: 'local',
      model: 'qwen3-coder-next',
      aggregateTokPerSec: 86.8,
      concurrency: 4,
      measuredAt: '2026-07-25T00:00:00.000Z',
    },
  }));

  const items = Array.from({ length: 40 }, () => ({ text: 'aaaa' }));
  const plan = await planBatch({
    endpoint,
    model: 'qwen3-coder-next',
    template: '{{text}}',
    items,
    throughputPath,
    probe: false,
  });
  assert.equal(plan.rate.measured, true);
  assert.equal(plan.rate.tokPerSec, 86.8);
  assert.match(plan.rate.source, /measured/);
  // 1 prompt token + 300 assumed completion tokens per item, 40 items.
  const expected = (40 * (1 + 300)) / 86.8;
  assert.ok(Math.abs(plan.etaSeconds - expected) < 1e-6);
});

test('planBatch probes the model: a 3-token completion shrinks the estimate ~100x', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');

  let calls = 0;
  const fakeClient = {
    async chat(_endpoint, { messages }) {
      calls += 1;
      assert.equal(messages.at(-1).role, 'user');
      return { message: { content: 'yes' }, usage: { completion_tokens: 3 } };
    },
  };
  const items = Array.from({ length: 40 }, () => ({ text: 'aaaa' }));
  const base = {
    endpoint,
    model: 'never-benched-model',
    template: '{{text}}',
    items,
    throughputPath,
  };

  const measuredPlan = await planBatch({ ...base, client: fakeClient });
  assert.equal(calls, 3, 'default probe samples 3 items');
  assert.equal(measuredPlan.completionTokensPerItem.value, 3);
  assert.match(measuredPlan.completionTokensPerItem.source, /measured \(n=3 sample\)/);

  const assumedPlan = await planBatch({ ...base, probe: false });
  assert.equal(assumedPlan.completionTokensPerItem.value, 300);
  assert.match(assumedPlan.completionTokensPerItem.source, /assumed/);

  // 301 vs 4 tokens/item is 75x here; with any non-trivial prompt it trends
  // to the full 100x of 300 vs 3. "Roughly 100x smaller" is the claim.
  const ratio = assumedPlan.totalTokens / measuredPlan.totalTokens;
  assert.ok(ratio > 50, `expected ~100x smaller estimate, got ${ratio}x`);
});

test('planBatch probe honours --allow via the constrained-output path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const fakeClient = {
    async chat(_endpoint, { messages }) {
      calls.push(messages);
      const constrained = messages.at(-1).content.includes('permitted answers');
      // Out-of-set answers ramble (50 tokens); the constrained retry is one word.
      return constrained
        ? { message: { content: 'yes' }, usage: { completion_tokens: 3 } }
        : { message: { content: 'maybe, perhaps, unclear' }, usage: { completion_tokens: 50 } };
    },
  };

  const plan = await planBatch({
    endpoint,
    model: 'never-benched-model',
    template: '{{text}}',
    items: Array.from({ length: 40 }, () => ({ text: 'aaaa' })),
    throughputPath: join(directory, 'throughput.json'),
    allowed: ['yes', 'no'],
    client: fakeClient,
  });

  assert.equal(calls.length, 6, 'each of the 3 probes needed one constrained retry');
  assert.ok(
    calls.filter((messages) => messages.at(-1).content.includes('permitted answers')).length === 3,
    'the probe must restate the constraint exactly like batch does',
  );
  assert.equal(plan.completionTokensPerItem.value, 3);
  assert.match(plan.completionTokensPerItem.source, /measured \(n=3 sample\)/);
});

test('planBatch falls back to the assumed default when the probe fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const failingClient = {
    async chat() {
      throw new Error('model not loaded');
    },
  };
  const plan = await planBatch({
    endpoint,
    model: 'never-benched-model',
    template: '{{text}}',
    items: Array.from({ length: 40 }, () => ({ text: 'aaaa' })),
    throughputPath: join(directory, 'throughput.json'),
    client: failingClient,
  });

  assert.equal(plan.completionTokensPerItem.value, 300);
  assert.match(plan.completionTokensPerItem.source, /assumed default/);
  assert.match(plan.completionTokensPerItem.source, /probe failed: model not loaded/);
  assert.ok(plan.etaSeconds > 0);
});
