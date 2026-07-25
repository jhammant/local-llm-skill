import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, budget } from '../src/ration.mjs';

const GB = 1024 ** 3;
const endpoint = {
  id: 'test',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
};

async function fixture(t, { loaded = [], models = [], pins = [], lru = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-ration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const pinsPath = join(directory, 'pins.json');
  const lruPath = join(directory, 'lru.json');
  await mkdir(directory, { recursive: true });
  await writeFile(pinsPath, JSON.stringify(pins));
  await writeFile(lruPath, JSON.stringify(lru));

  const calls = [];
  const client = {
    async ps(receivedEndpoint) {
      assert.equal(receivedEndpoint, endpoint);
      return loaded.map((item) => ({ ...item }));
    },
    async listModels(receivedEndpoint) {
      assert.equal(receivedEndpoint, endpoint);
      return models.map((item) => ({ ...item }));
    },
    async load(receivedEndpoint, model, options) {
      calls.push({ operation: 'load', endpoint: receivedEndpoint, model, options });
    },
    async unload(receivedEndpoint, identifier) {
      calls.push({ operation: 'unload', endpoint: receivedEndpoint, identifier });
    },
  };
  const options = {
    client,
    totalMemBytes: 128 * GB,
    wiredLimitMb: 0,
    env: {},
    configPath,
    pinsPath,
    lruPath,
  };
  return { calls, client, options, pinsPath, lruPath };
}

test('budget treats a zero wired limit as 75 percent of total RAM', async (t) => {
  const { options } = await fixture(t);
  const report = await budget(endpoint, options);
  assert.equal(report.totalGb, 128);
  assert.equal(report.ceilingGb, 96);
  assert.equal(report.reserveGb, 12);
  assert.equal(report.budgetGb, 84);
  assert.equal(report.freeGb, 84);
});

test('admit loads a model that fits without evicting', async (t) => {
  const { calls, options } = await fixture(t, {
    loaded: [
      { identifier: 'resident', model: 'resident/model', sizeGb: 20, parallel: 4 },
    ],
    models: [
      { id: 'target/model', sizeGb: 30, maxContext: 16_384 },
    ],
  });

  const result = await admit(endpoint, 'target/model', options);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'load');
  assert.deepEqual(result.evicted, []);
  assert.deepEqual(calls, [{
    operation: 'load',
    endpoint,
    model: 'target/model',
    options: { identifier: 'target/model', contextLength: 16_384 },
  }]);
});

test('admit evicts the least-recently-used model first', async (t) => {
  const { calls, options } = await fixture(t, {
    loaded: [
      { identifier: 'newer-id', model: 'newer/model', sizeGb: 40, parallel: 4 },
      { identifier: 'older-id', model: 'older/model', sizeGb: 30, parallel: 4 },
    ],
    models: [{ id: 'target/model', sizeGb: 25, maxContext: 8_192 }],
    lru: { 'newer-id': 200, 'older-id': 100 },
  });

  const result = await admit(endpoint, 'target/model', options);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'evict-and-load');
  assert.deepEqual(result.evicted, ['older-id']);
  assert.deepEqual(calls.map((call) => call.operation), ['unload', 'load']);
  assert.equal(calls[0].identifier, 'older-id');
});

test('admit accounts for an already overcommitted budget when planning eviction', async (t) => {
  const { calls, options } = await fixture(t, {
    loaded: [
      { identifier: 'first-id', model: 'first/model', sizeGb: 30, parallel: 4 },
      { identifier: 'second-id', model: 'second/model', sizeGb: 30, parallel: 4 },
      { identifier: 'third-id', model: 'third/model', sizeGb: 40, parallel: 4 },
    ],
    models: [{ id: 'target/model', sizeGb: 20, maxContext: 8_192 }],
    lru: { 'first-id': 1, 'second-id': 2, 'third-id': 3 },
  });

  const result = await admit(endpoint, 'target/model', options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evicted, ['first-id', 'second-id']);
  assert.deepEqual(
    calls.filter((call) => call.operation === 'unload').map((call) => call.identifier),
    ['first-id', 'second-id'],
  );
});

test('admit never auto-evicts a pinned model', async (t) => {
  const { calls, options } = await fixture(t, {
    loaded: [
      { identifier: 'pinned-id', model: 'pinned/model', sizeGb: 50, parallel: 4 },
      { identifier: 'free-id', model: 'free/model', sizeGb: 20, parallel: 4 },
    ],
    models: [{ id: 'target/model', sizeGb: 30, maxContext: 4_096 }],
    pins: ['pinned/model'],
    lru: { 'pinned-id': 1, 'free-id': 2 },
  });

  const result = await admit(endpoint, 'target/model', options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evicted, ['free-id']);
  assert.equal(calls.some((call) => call.identifier === 'pinned-id'), false);
});

test('admit rejects a model larger than the budget with a sysctl remedy', async (t) => {
  const { calls, options } = await fixture(t, {
    models: [{ id: 'minimax-m2.7', sizeGb: 100, maxContext: 4_096 }],
  });

  const result = await admit(endpoint, 'minimax-m2.7', options);
  assert.equal(result.ok, false);
  assert.equal(result.action, 'too-big');
  assert.match(result.reason, /sudo sysctl iogpu\.wired_limit_mb=\d+/);
  assert.deepEqual(calls, []);
});

test('dry-run returns the eviction plan without mutating clients or state', async (t) => {
  const { calls, options, pinsPath, lruPath } = await fixture(t, {
    loaded: [
      { identifier: 'old-id', model: 'old/model', sizeGb: 70, parallel: 4 },
    ],
    models: [{ id: 'target/model', sizeGb: 20, maxContext: 4_096 }],
    lru: { 'old-id': 10 },
  });
  const pinsBefore = await readFile(pinsPath, 'utf8');
  const lruBefore = await readFile(lruPath, 'utf8');

  const result = await admit(endpoint, 'target/model', { ...options, dryRun: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.evicted, ['old-id']);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(pinsPath, 'utf8'), pinsBefore);
  assert.equal(await readFile(lruPath, 'utf8'), lruBefore);
});
