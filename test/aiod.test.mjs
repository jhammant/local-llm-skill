import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AIOD_INSTALL_HINT,
  burstEndpoint,
  estimate,
  resolveAiod,
  runWithTeardown,
  spin,
  status,
  teardown,
} from '../src/aiod.mjs';

test('resolveAiod honours AIOD_BIN when it is executable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-aiod-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'aiod');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  const resolved = await resolveAiod({ env: { AIOD_BIN: binary } });
  assert.equal(resolved, binary);
});

test('resolveAiod treats an unusable AIOD_BIN as unavailable, not an error', async () => {
  assert.equal(
    await resolveAiod({ env: { AIOD_BIN: '/definitely/not/a/real/aiod' } }),
    null,
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

  const endpoint = await burstEndpoint({
    env: { AIOD_BIN: binary },
    fetchFn: async () => {
      throw new Error('fake proxy absent');
    },
    statePath: join(directory, 'missing-state.json'),
  });
  assert.equal(endpoint.available, true);
  assert.equal(endpoint.binary, binary);
  // The stub never provisions: no endpoint address is ever synthesized.
  assert.equal(endpoint.baseUrl, null);
});

test('estimate parses aiod output without any paid spawn path', async () => {
  let calls = 0;
  const result = await estimate('org/model', {
    binary: '/fake/aiod',
    quant: 'fp8',
    execFileFn: (_file, args, _options, callback) => {
      calls += 1;
      assert.deepEqual(args, ['estimate', 'org/model', '--quant', 'fp8']);
      callback(
        null,
        [
          '│ Quant │ VRAM  │ Cheapest fit │ GPUs │ Live price │',
          '│ fp8   │ 44 GB │ H100 80GB    │ 1    │ $2.40/hr   │',
        ].join('\n'),
        '',
      );
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.available, true);
  assert.equal(result.vramGb, 44);
  assert.equal(result.gpu, 'H100 80GB');
  assert.equal(result.pricePerHour, 2.4);
});

test('status prefers the structured local proxy and never invokes the CLI when it answers', async () => {
  let cliCalls = 0;
  const now = 1_800_000_000_000;
  const current = await status({
    binary: '/fake/aiod',
    now,
    fetchFn: async (url) => {
      assert.equal(url, 'http://127.0.0.1:4000/aiod/status');
      return {
        ok: true,
        async json() {
          return {
            idle_minutes: 20,
            idle_seconds: 300,
            instance: {
              instance_id: 99,
              repo_id: 'org/model',
              quant: 'fp8',
              gpu_desc: '1x H100',
              price_per_hr: 2.4,
              created_at: now / 1_000 - 900,
              ttl_hours: 2,
              host: '203.0.113.5',
              port: 8000,
              api_key: 'secret',
              status: 'running',
            },
          };
        },
      };
    },
    execFileFn: () => {
      cliCalls += 1;
      throw new Error('CLI must not run');
    },
  });
  assert.equal(cliCalls, 0);
  assert.equal(current.serving, true);
  assert.equal(current.idleRemaining, 15);
  assert.equal(current.apiKey, 'secret');
});

function dryRunExec(_file, args, _options, callback) {
  assert.equal(args[0], 'spin');
  assert.ok(args.includes('--dry-run'), 'proposal must use aiod dry-run');
  callback(
    null,
    [
      'Launch plan',
      'GPU:   1x H100 SXM 80GB  ·  reliability 99%',
      'Price: $2.40/hr  (~$4.80 over a 2h session)',
      'DRY RUN — nothing rented',
    ].join('\n'),
    '',
  );
}

test('spin is proposed but the paid subprocess is never spawned without per-call confirmation', async () => {
  let spawnCalls = 0;
  const planOutput = [];
  const result = await spin(
    {
      profile: 'qwen3-coder-30b',
      quant: 'fp8',
      maxPrice: 3,
      idle: 20,
      ttl: 2,
      estimatedRuntimeMinutes: 30,
    },
    {
      binary: '/fake/aiod',
      execFileFn: dryRunExec,
      spawnFn() {
        spawnCalls += 1;
        throw new Error('paid spin must not be called');
      },
      output: { write: (value) => planOutput.push(value) },
    },
  );

  assert.equal(result.status, 'proposed');
  assert.equal(result.executed, false);
  assert.equal(result.plan.gpu, '1x H100 SXM 80GB');
  assert.equal(result.plan.pricePerHour, 2.4);
  assert.equal(result.plan.estimatedTotalCost, 1.2);
  assert.match(planOutput.join(''), /BURST LAUNCH PLAN/);
  assert.equal(spawnCalls, 0);
});

test('spin refuses before proposal or spawn when either --idle or --ttl is missing', async () => {
  let subprocessCalls = 0;
  const options = {
    binary: '/fake/aiod',
    execFileFn() {
      subprocessCalls += 1;
      throw new Error('must not execute');
    },
    spawnFn() {
      subprocessCalls += 1;
      throw new Error('must not spawn');
    },
  };

  await assert.rejects(
    spin({ profile: 'coder', ttl: 2 }, options),
    /--idle/,
  );
  await assert.rejects(
    spin({ profile: 'coder', idle: 20 }, options),
    /--ttl/,
  );
  assert.equal(subprocessCalls, 0);
});

test('burst run teardown executes from finally when work throws mid-run', async () => {
  let teardownCalls = 0;
  await assert.rejects(
    runWithTeardown(
      async () => {
        throw new Error('mid-batch failure');
      },
      {
        teardownFn: async () => {
          teardownCalls += 1;
        },
      },
    ),
    /mid-batch failure/,
  );
  assert.equal(teardownCalls, 1);
});

test('confirmed spin still prints its complete plan when no callback is supplied', async () => {
  const writes = [];
  let spawnCalls = 0;
  const result = await spin(
    {
      profile: 'qwen3-coder-30b',
      idle: 20,
      ttl: 2,
      estimatedRuntimeMinutes: 30,
    },
    {
      binary: '/fake/aiod',
      confirmed: true,
      execFileFn: dryRunExec,
      output: { write: (value) => writes.push(value) },
      spawnFn: async () => {
        spawnCalls += 1;
      },
      statusFn: async () => ({
        running: true,
        serving: true,
        baseUrl: 'http://burst.test',
        apiKey: 'fake-token',
      }),
    },
  );

  assert.equal(result.executed, true);
  assert.equal(spawnCalls, 1);
  assert.match(writes.join(''), /BURST LAUNCH PLAN/);
  assert.match(writes.join(''), /H100/);
  assert.match(writes.join(''), /\$2\.40\/hr/);
  assert.match(writes.join(''), /Estimated total/);
  assert.match(writes.join(''), /Idle timeout/);
  assert.match(writes.join(''), /TTL hard backstop/);
});

test('an abort during readiness polling tears down instead of returning a live burst', async () => {
  const controller = new AbortController();
  let statusPolls = 0;
  let teardownCalls = 0;
  const execFileFn = (_file, args, _options, callback) => {
    if (args[0] === 'spin') {
      dryRunExec(_file, args, _options, callback);
      return;
    }
    assert.equal(args[0], 'teardown');
    assert.equal(_options.signal, undefined, 'cleanup must not inherit an aborted signal');
    teardownCalls += 1;
    callback(null, 'destroyed', '');
  };

  await assert.rejects(
    spin(
      { profile: 'coder', idle: 20, ttl: 2 },
      {
        binary: '/fake/aiod',
        confirmed: true,
        onPlan: () => {},
        execFileFn,
        spawnFn: async () => {},
        signal: controller.signal,
        sleepFn: async () => {},
        statusFn: async () => {
          statusPolls += 1;
          controller.abort();
          return { running: true, serving: false, state: 'loading' };
        },
      },
    ),
    /aborted/i,
  );
  assert.equal(statusPolls, 1);
  assert.equal(teardownCalls, 1);
});

test('teardown treats an already-empty tracked slot as successful and idempotent', async () => {
  const result = await teardown({
    binary: '/fake/aiod',
    execFileFn: (_file, args, _options, callback) => {
      assert.deepEqual(args, ['teardown', '--yes']);
      callback(null, 'Nothing to tear down', '');
    },
  });
  assert.deepEqual(result, { available: true, destroyed: false });
});

test('status parses Rich CLI output and recovers the bearer token from structured state', async () => {
  const now = 1_800_000_000_000;
  const rich = [
    '┏━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ Field        ┃ Value                            ┃',
    '┡━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┩',
    '│ Instance     │ 4242                             │',
    '│ Model        │ org/private-model                │',
    '│ GPU          │ 1x H100 SXM 80GB (fp8)           │',
    '│ Endpoint     │ http://203.0.113.10:8000/v1      │',
    '│ Price        │ $2.40/hr                         │',
    '│ Running for  │ 30m (~$1.20 so far)              │',
    '│ TTL          │ 1.50h remaining                  │',
    '└──────────────┴──────────────────────────────────┘',
  ].join('\n');
  const current = await status({
    binary: '/fake/aiod',
    now,
    fetchFn: async () => {
      throw new Error('proxy unavailable');
    },
    execFileFn: (_file, args, _options, callback) => {
      assert.deepEqual(args, ['status']);
      callback(null, rich, '');
    },
    readFileFn: async () => JSON.stringify({
      instance_id: 4242,
      repo_id: 'org/private-model',
      quant: 'fp8',
      gpu_desc: '1x H100 SXM 80GB',
      price_per_hr: 2.4,
      created_at: now / 1_000 - 1_800,
      ttl_hours: 2,
      host: '203.0.113.10',
      port: 8000,
      api_key: 'per-instance-secret',
      status: 'running',
      idle_minutes: 20,
    }),
  });

  assert.equal(current.running, true);
  assert.equal(current.serving, true);
  assert.equal(current.instanceId, 4242);
  assert.equal(current.baseUrl, 'http://203.0.113.10:8000');
  assert.equal(current.apiKey, 'per-instance-secret');
  assert.equal(current.gpu, '1x H100 SXM 80GB');
  assert.equal(current.pricePerHour, 2.4);
  assert.equal(current.costSoFar, 1.2);
});
