import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIOD_INSTALL_HINT, burstEndpoint, resolveAiod } from '../src/aiod.mjs';

test('resolveAiod honours AIOD_BIN when it is executable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-aiod-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'aiod');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  const resolved = await resolveAiod({ env: { AIOD_BIN: binary } });
  assert.equal(resolved, binary);
});

test('resolveAiod throws when AIOD_BIN is set but unusable', async () => {
  await assert.rejects(
    resolveAiod({ env: { AIOD_BIN: '/definitely/not/a/real/aiod' } }),
    /AIOD_BIN/,
  );
});

test('resolveAiod returns null when aiod is absent', async () => {
  const missingWhich = (_file, _args, _options, callback) => {
    callback(new Error('not found'), '');
  };
  const resolved = await resolveAiod({ env: {}, execFileFn: missingWhich });
  assert.equal(resolved, null);
});

test('burstEndpoint reports the burst endpoint unavailable without aiod', async () => {
  const missingWhich = (_file, _args, _options, callback) => {
    callback(new Error('not found'), '');
  };
  const endpoint = await burstEndpoint({ env: {}, execFileFn: missingWhich });
  assert.equal(endpoint.id, 'burst');
  assert.equal(endpoint.control, 'aiod');
  assert.equal(endpoint.available, false);
  assert.equal(endpoint.reason, AIOD_INSTALL_HINT);
  assert.equal(endpoint.baseUrl, null);
});

test('burstEndpoint reports availability when aiod exists, without provisioning anything', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-aiod-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'aiod');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  const endpoint = await burstEndpoint({ env: { AIOD_BIN: binary } });
  assert.equal(endpoint.available, true);
  assert.equal(endpoint.binary, binary);
  // The stub never provisions: no endpoint address is ever synthesized.
  assert.equal(endpoint.baseUrl, null);
});
