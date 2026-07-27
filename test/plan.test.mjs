import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBurstComparison,
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

test('burst comparison uses total tokens divided by aggregate rate and live price', () => {
  const comparison = buildBurstComparison(
    {
      endpoint: 'local',
      model: 'local/model',
      totalTokens: 340_000,
      etaSeconds: 3_600,
      etaMethod: 'measured end-to-end',
    },
    {
      profile: 'coder',
      gpu: '1x H100',
      pricePerHour: 2.4,
      idleMinutes: 20,
      ttlHours: 2,
    },
    {
      tokPerSec: 340,
      rateSource: 'assumed default',
    },
  );

  assert.equal(comparison.burst.etaSeconds, 1_000);
  assert.ok(Math.abs(comparison.burst.estimatedCost - (2.4 * 1_000 / 3_600)) < 1e-12);
  assert.equal(comparison.timeSavedSeconds, 2_600);
  assert.equal(comparison.burst.rateSource, 'assumed default');
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
    sample: false,
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
    sample: false,
    probe: false,
  });
  assert.equal(plan.rate.measured, true);
  assert.equal(plan.rate.tokPerSec, 86.8);
  assert.match(plan.rate.source, /measured/);
  // No itemsPerSec or prefill/decode rates recorded -> single-rate fallback.
  assert.match(plan.etaMethod, /single aggregate rate \(least accurate/);
  // 1 prompt token + 300 assumed completion tokens per item, 40 items.
  const expected = (40 * (1 + 300)) / 86.8;
  assert.ok(Math.abs(plan.etaSeconds - expected) < 1e-6);
});

test('regression: a timed end-to-end sample puts 3803 short-output items at ~2030s', async (t) => {
  // Ground truth from laguna-s-2.1 (reasoning_effort=none): 3803 items of
  // 154 prompt + 2.7 completion tokens each ran at 1.87 items/s (~34 min).
  // Every token-rate model failed against this: single aggregate predicted
  // ~6289s (3x over), bench's items/s — measured on bench's own long-
  // generation prompt — predicted ~10865s (5x over), and separate
  // prefill/decode rates predicted ~7m (5x under, because short requests are
  // dominated by fixed per-request overhead). plan must time a real sample of
  // the actual job instead. The bench record below deliberately carries the
  // misleading 0.35 items/s to prove plan never consults it.
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');
  await writeFile(throughputPath, JSON.stringify({
    'local/laguna-s-2.1': {
      endpoint: 'local',
      model: 'laguna-s-2.1',
      singleTokPerSec: 94.9,
      aggregateTokPerSec: 94.9,
      promptTokPerSec: 2000,
      completionTokPerSec: 94.9,
      itemsPerSec: 0.35,
      concurrency: 4,
      measuredAt: '2026-07-25T00:00:00.000Z',
    },
  }));

  // Fake client + fake clock: each of the 8 sample items advances the clock
  // 0.535s, so the sample takes 4.28s wall clock = 1.87 items/s.
  let clock = 1_000_000;
  let calls = 0;
  const seen = [];
  const fakeClient = {
    async chat(_endpoint, { messages, reasoningEffort }) {
      calls += 1;
      seen.push({ messages, reasoningEffort });
      clock += 535;
      return {
        message: { content: 'bugfix' },
        usage: { prompt_tokens: 154, completion_tokens: 2.7 },
      };
    },
  };

  const plan = await planBatch({
    endpoint,
    model: 'laguna-s-2.1',
    template: 'Classify: {{text}}',
    items: Array.from({ length: 3803 }, () => ({ text: 'some review text' })),
    throughputPath,
    allowed: ['bugfix', 'feature'],
    reasoningEffort: 'none',
    client: fakeClient,
    now: () => clock,
  });

  assert.equal(calls, 8, 'the default sample runs 8 real items end-to-end');
  assert.ok(
    seen.every(({ reasoningEffort }) => reasoningEffort === 'none'),
    'the sample must run with the same reasoning effort as the real batch',
  );
  assert.match(plan.etaMethod, /measured \(end-to-end sample of 8 items\)/);
  assert.ok(Math.abs(plan.itemsPerSec.value - 8 / 4.28) < 1e-9);
  const GROUND_TRUTH_SECONDS = 2030; // 3803 items at 1.87 items/s
  assert.ok(
    Math.abs(plan.etaSeconds - GROUND_TRUTH_SECONDS) / GROUND_TRUTH_SECONDS <= 0.25,
    `ETA ${plan.etaSeconds}s must be within 25% of the ${GROUND_TRUTH_SECONDS}s ground truth`,
  );
  // The same sample replaces the chars/4 heuristic and the 300-token
  // assumption with API-reported usage.
  assert.equal(plan.sample.promptTokensPerItem, 154);
  assert.match(plan.sample.source, /measured \(end-to-end sample of 8 items\)/);
  assert.equal(plan.completionTokensPerItem.value, 2.7);
  assert.match(plan.completionTokensPerItem.source, /measured \(end-to-end sample of 8 items\)/);
});

test('--no-sample keeps the token-rate estimate, labelled least accurate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');
  await writeFile(throughputPath, JSON.stringify({
    'local/laguna-s-2.1': {
      endpoint: 'local',
      model: 'laguna-s-2.1',
      aggregateTokPerSec: 94.9,
      itemsPerSec: 0.35,
      concurrency: 4,
      measuredAt: '2026-07-25T00:00:00.000Z',
    },
  }));

  let calls = 0;
  const fakeClient = {
    async chat() {
      calls += 1;
      return { message: { content: 'bugfix' }, usage: { completion_tokens: 3 } };
    },
  };

  // 616 chars / 4 chars-per-token = exactly 154 prompt tokens per item.
  const plan = await planBatch({
    endpoint,
    model: 'laguna-s-2.1',
    template: 'x'.repeat(616),
    items: Array.from({ length: 3803 }, () => ({ text: 'ignored' })),
    throughputPath,
    sample: false,
    probe: false,
    completionTokensPerItem: 2.7,
    client: fakeClient,
  });

  assert.equal(calls, 0, '--no-sample must not touch the model');
  assert.equal(plan.itemsPerSec, null);
  assert.match(plan.etaMethod, /least accurate/);
  // bench's misleading 0.35 items/s (=> ~10865s) must not be consulted; the
  // fallback is the single aggregate rate over 154 + 2.7 tokens per item.
  const expected = (3803 * (154 + 2.7)) / 94.9;
  assert.ok(Math.abs(plan.etaSeconds - expected) < 1e-6);
});

test('a failing end-to-end sample falls back instead of crashing', async (t) => {
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
    sleep: async () => {},
    probe: false,
  });

  assert.ok(plan.etaSeconds > 0);
  assert.match(plan.etaMethod, /least accurate/);
  assert.match(plan.etaMethod, /end-to-end sample failed: 8 of 8 sampled item\(s\) failed/);
});

test('planBatch combines separate prefill/decode rates when sampling is disabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');
  await writeFile(throughputPath, JSON.stringify({
    'local/laguna-s-2.1': {
      endpoint: 'local',
      model: 'laguna-s-2.1',
      aggregateTokPerSec: 94.9,
      promptTokPerSec: 2000,
      completionTokPerSec: 94.9,
      concurrency: 4,
      measuredAt: '2026-07-25T00:00:00.000Z',
    },
  }));

  const plan = await planBatch({
    endpoint,
    model: 'laguna-s-2.1',
    template: 'x'.repeat(616),
    items: Array.from({ length: 3803 }, () => ({ text: 'ignored' })),
    throughputPath,
    sample: false,
    probe: false,
    completionTokensPerItem: 2.7,
  });

  assert.match(plan.etaMethod, /separate prefill\/decode rates/);
  // (154/2000 + 2.7/94.9) seconds/item x 3803 items / 4 slots.
  const expected = ((154 / 2000 + 2.7 / 94.9) * 3803) / 4;
  assert.ok(Math.abs(plan.etaSeconds - expected) < 1e-6);
  // Far closer to the ~2030s ground truth than the ~6289s single-rate figure.
  assert.ok(Math.abs(plan.etaSeconds - 2030) < Math.abs(plan.etaSeconds - 6289));
});

test('planBatch ignores a bench record flagged unreliable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');
  await writeFile(throughputPath, JSON.stringify({
    'local/noisy-model': {
      endpoint: 'local',
      model: 'noisy-model',
      singleTokPerSec: 64,
      aggregateTokPerSec: 32,
      concurrency: 4,
      maxTokens: 512,
      runs: 3,
      warning: 'unreliable (aggregate below single-stream)',
      measuredAt: '2026-07-25T00:00:00.000Z',
    },
  }));

  const plan = await planBatch({
    endpoint,
    model: 'noisy-model',
    template: '{{text}}',
    items: Array.from({ length: 40 }, () => ({ text: 'aaaa' })),
    throughputPath,
    sample: false,
    probe: false,
  });

  // An impossible measurement must not drive the ETA — fall back to the
  // labelled assumed default instead.
  assert.equal(plan.rate.measured, false);
  assert.equal(plan.rate.tokPerSec, 30);
  assert.match(plan.rate.source, /assumed default/);
  assert.match(plan.rate.source, /unreliable bench measurement ignored/);
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
    sample: false,
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
    sample: false,
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
    sample: false,
    client: failingClient,
  });

  assert.equal(plan.completionTokensPerItem.value, 300);
  assert.match(plan.completionTokensPerItem.source, /assumed default/);
  assert.match(plan.completionTokensPerItem.source, /probe failed: model not loaded/);
  assert.ok(plan.etaSeconds > 0);
});
