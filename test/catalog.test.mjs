import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../src/catalog.mjs';

const endpoint = {
  id: 'test',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'none',
  capacityGb: null,
};

const admissible = async (_endpoint, _id, options) => {
  assert.equal(options.dryRun, true);
  return { ok: true, action: 'already-loaded', evicted: [], reason: 'test' };
};

function clientWith(models) {
  return {
    async listModels(receivedEndpoint) {
      assert.equal(receivedEndpoint, endpoint);
      return models;
    },
  };
}

test('selection uses the next preference when the first model is absent', async () => {
  const secondPreference = {
    id: 'qwen/qwen3.6-27b',
    type: 'llm',
    capabilities: [],
    sizeGb: 17,
  };
  const result = await selectModel({
    class: 'workhorse',
    endpoint,
    client: clientWith([secondPreference]),
    admitFn: admissible,
  });
  assert.equal(result.id, secondPreference.id);
  assert.equal(result.class, 'workhorse');
});

test('selection falls back to the next smaller class', async () => {
  const reflex = {
    id: 'google/gemma-3-4b',
    type: 'llm',
    capabilities: [],
    sizeGb: 4,
  };
  const result = await selectModel({
    class: 'coder',
    endpoint,
    client: clientWith([reflex]),
    admitFn: admissible,
  });
  assert.equal(result.id, reflex.id);
  assert.equal(result.class, 'reflex');
  assert.match(result.why, /falling back from coder/);
});

test('security models are never selected unless security is explicit', async () => {
  const security = {
    id: 'qwen3.6-35b-a3b-abliterated-heretic-mlx',
    type: 'llm',
    capabilities: [],
    sizeGb: 30,
  };
  const client = clientWith([security]);

  await assert.rejects(
    selectModel({
      endpoint,
      client,
      admitFn: admissible,
    }),
    /No admissible model found for class "workhorse"/,
  );

  const selected = await selectModel({
    class: 'security',
    endpoint,
    client,
    admitFn: admissible,
  });
  assert.equal(selected.id, security.id);
  assert.equal(selected.class, 'security');
});
