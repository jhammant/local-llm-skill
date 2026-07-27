#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { getEndpoint, defaultEndpoint, listEndpoints } from './endpoints.mjs';
import { resolve } from './providers/index.mjs';
import { validateReasoningEffort } from './providers/http.mjs';
import {
  admit,
  budget,
  listPins,
  pinModel,
  unpinModel,
} from './ration.mjs';
import { JOB_CLASSES, selectModel } from './catalog.mjs';
import { ask } from './ask.mjs';
import {
  ITEM_LINE,
  inspectBatch,
  readItems,
  runBatch,
  substituteTemplate,
} from './batch.mjs';
import {
  ASSUMED_BURST_TOK_PER_SEC,
  buildBurstComparison,
  planBatch,
  readThroughput,
  throughputKey,
} from './plan.mjs';
import { recordThroughput, runBench } from './bench.mjs';
import { checkUpdates } from './updates.mjs';
import {
  AIOD_INSTALL_HINT,
  burstEndpoint,
  burstWarning,
  propose as proposeBurst,
  spin as spinBurst,
  status as burstStatus,
  teardown as teardownBurst,
} from './aiod.mjs';
import { isBurstEndpoint, requireRemoteDataOptIn } from './remote-data.mjs';

const VERSION = '1.0.0';
const VALUE_OPTIONS = new Set([
  'endpoint',
  'class',
  'model',
  'template',
  'prompt',
  'out',
  'field',
  'system',
  'concurrency',
  'allow',
  'sample',
  'max-tokens',
  'runs',
  'reasoning-effort',
  'profile',
  'quant',
  'max-price',
  'idle',
  'ttl',
  'overflow',
]);
const BOOLEAN_OPTIONS = new Set([
  'json',
  'fit',
  'uncensored',
  'restart',
  'dry-run',
  'all',
  'no-sample',
  'check-updates',
  'yes',
  'allow-remote-data',
  'help',
  'version',
]);

const HELP = `local-llm ${VERSION}

Usage:
  local-llm endpoints [--json]
  local-llm models [--fit] [--class <c>] [--check-updates] [--json]
  local-llm ps [--json]
  local-llm budget [--json]
  local-llm status [--json]
  local-llm burst status
  local-llm burst up [--profile p | --model m] [--quant q] [--max-price N]
      --idle M --ttl H [--yes]
  local-llm burst down
  local-llm ask <prompt…> [--class c] [--model m] [--uncensored]
      [--reasoning-effort e] [--endpoint burst] [--allow-remote-data]
      [--idle M --ttl H] [--yes] [--json]
  local-llm batch <items.jsonl> (--template f | --prompt s) [--out f]
      [--class c] [--model m] [--field name] [--system f]
      [--concurrency n] [--allow a,b,c] [--reasoning-effort e]
      [--endpoint burst | --overflow burst] [--allow-remote-data]
      [--idle M --ttl H] [--yes] [--restart] [--dry-run] [--json]
  local-llm plan <items.jsonl> (--template f | --prompt s)
      [--class c] [--model m] [--field name] [--allow a,b,c]
      [--reasoning-effort e] [--sample n] [--no-sample]
      [--endpoint burst] [--allow-remote-data] [--idle M --ttl H] [--yes] [--json]
  local-llm bench [--model m] [--class c] [--max-tokens n] [--runs n]
      [--endpoint burst] [--allow-remote-data] [--idle M --ttl H] [--yes] [--json]
  local-llm load <model> [--dry-run] [--json]
  local-llm unload <identifier | --all> [--json]
  local-llm pin <model> | unpin <model> | pins [--json]
  local-llm --version

Global:
  --endpoint <id>   endpoint registry id (default: configured local endpoint)
  --allow-remote-data   per-run permission to send data to the public burst endpoint
  --idle <minutes>  required on every invocation that may rent a burst GPU
  --ttl <hours>     required hard lifetime limit on every burst spin
  --yes             confirm this invocation's displayed burst plan without stdin
  --reasoning-effort <none|low|medium|high>   opt-in; omitted from the request
                    when unset, for thinking models on ask/batch/plan
`;

function optionName(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const equal = argument.indexOf('=');
    const rawName = argument.slice(2, equal < 0 ? undefined : equal);
    if (BOOLEAN_OPTIONS.has(rawName)) {
      if (equal >= 0) {
        throw new Error(`Option --${rawName} does not take a value`);
      }
      options[optionName(rawName)] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(rawName)) throw new Error(`Unknown option --${rawName}`);
    const value = equal >= 0 ? argument.slice(equal + 1) : argv[++index];
    if (value == null || value === '') throw new Error(`Option --${rawName} requires a value`);
    options[optionName(rawName)] = value;
  }
  return { options, positionals };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printRows(rows, columns) {
  if (rows.length === 0) {
    process.stdout.write('None\n');
    return;
  }
  process.stdout.write(`${columns.map((column) => column.label).join('\t')}\n`);
  for (const row of rows) {
    process.stdout.write(`${columns.map((column) => column.value(row)).join('\t')}\n`);
  }
}

function roundGb(value) {
  return `${Number(value).toFixed(2)} GB`;
}

function withoutLoaded(report) {
  const { loaded: _loaded, ...memory } = report;
  return memory;
}

function defaultOutputPath(input) {
  return /\.jsonl$/i.test(input)
    ? input.replace(/\.jsonl$/i, '.out.jsonl')
    : `${input}.out.jsonl`;
}

async function fileOrLiteral(value) {
  try {
    return await readFile(value, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return value;
    throw new Error(`Could not read ${value}: ${error.message}`, { cause: error });
  }
}

async function chooseEndpoint(id) {
  return id ? getEndpoint(id) : defaultEndpoint();
}

function numericOption(options, name, { integer = false } = {}) {
  if (options[name] == null) return undefined;
  const value = Number(options[name]);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    const flag = name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
    throw new Error(`--${flag} requires a positive ${integer ? 'integer' : 'number'}; received "${options[name]}"`);
  }
  return value;
}

function formatBurstPlan(plan) {
  return [
    'BURST LAUNCH PLAN — THIS WILL SPEND REAL MONEY',
    `  Model/profile:      ${plan.model ?? plan.profile ?? '?'}`,
    `  GPU:                ${plan.gpu}`,
    `  Live price:         $${plan.pricePerHour.toFixed(2)}/hr`,
    `  Estimated runtime:  ${formatDuration(plan.estimatedRuntimeMinutes * 60_000)} (estimate)`,
    `  Estimated total:    ~$${plan.estimatedTotalCost.toFixed(2)} (estimate)`,
    `  Idle timeout:       ${plan.idleMinutes}m`,
    `  TTL hard backstop:  ${plan.ttlHours}h`,
  ].join('\n');
}

async function confirmBurstPlan(signal) {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await input.question(
      'Rent this GPU? Type y to confirm this invocation: ',
      signal == null ? undefined : { signal },
    );
    return answer.trim().toLowerCase() === 'y';
  } catch {
    return false;
  } finally {
    input.close();
  }
}

export function installInterruptHandlers(controller, processLike = process) {
  let interruptedSignal = null;
  const onSigint = () => {
    interruptedSignal = 'SIGINT';
    controller.abort();
  };
  const onSigterm = () => {
    interruptedSignal = 'SIGTERM';
    controller.abort();
  };
  // Keep swallowing repeated termination signals until teardown completes;
  // a second Ctrl-C must not kill the process while the paid instance is
  // still being destroyed.
  processLike.on('SIGINT', onSigint);
  processLike.on('SIGTERM', onSigterm);
  return {
    get signal() {
      return interruptedSignal;
    },
    remove() {
      processLike.removeListener('SIGINT', onSigint);
      processLike.removeListener('SIGTERM', onSigterm);
    },
  };
}

function mergeBurstEndpoint(endpoint, current) {
  return {
    ...endpoint,
    kind: 'aiod',
    control: 'aiod',
    available: true,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    model: current.model ?? endpoint.model ?? null,
    quant: current.quant ?? endpoint.quant ?? null,
    status: current,
  };
}

async function activateBurstEndpoint(
  endpoint,
  options,
  { estimatedRuntimeMinutes, model = null, signal, proposalOnly = false } = {},
) {
  const current = await burstStatus(
    {
      ...(endpoint.binary == null ? {} : { binary: endpoint.binary }),
      signal,
    },
  );
  if (current.serving && current.baseUrl) {
    return { endpoint: mergeBurstEndpoint(endpoint, current), executed: false, existing: true };
  }
  const idle = numericOption(options, 'idle', { integer: true });
  const ttl = numericOption(options, 'ttl');
  // spin() repeats this validation. Keeping it here makes the CLI error name
  // the missing per-invocation flags before any dry-run subprocess is started.
  if (idle == null || ttl == null) {
    throw new Error('Burst spin requires BOTH --idle <minutes> and --ttl <hours> on this invocation');
  }
  if (options.model && options.profile) {
    throw new Error('Use either --model or --profile for a burst, not both');
  }
  const maxPrice = numericOption(options, 'maxPrice') ?? endpoint.maxPricePerHour ?? 3;
  const result = await spinBurst(
    {
      model: options.model ?? model ?? undefined,
      profile:
        options.profile
        ?? (options.model || model ? undefined : (endpoint.profile ?? 'qwen3-coder-30b')),
      quant: options.quant ?? endpoint.quant ?? 'fp8',
      maxPrice,
      idle,
      ttl,
      estimatedRuntimeMinutes: estimatedRuntimeMinutes ?? ttl * 60,
    },
    {
      binary: endpoint.binary,
      confirmed: !proposalOnly && options.yes === true,
      confirmFn: proposalOnly || options.yes ? undefined : () => confirmBurstPlan(signal),
      onPlan: (plan) => (options.json ? process.stderr : process.stdout)
        .write(`${formatBurstPlan(plan)}\n`),
      onStdout: (chunk) => process.stderr.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
      signal,
    },
  );
  if (!result.executed) return { endpoint, executed: false, proposed: true, plan: result.plan };
  return {
    endpoint: mergeBurstEndpoint(endpoint, result.endpoint),
    executed: true,
    existing: false,
    plan: result.plan,
  };
}

async function getAvailableBurstEndpoint() {
  const endpoint = await burstEndpoint();
  if (!endpoint.available) return null;
  return endpoint;
}

export async function selectOverflowEndpoint({
  endpoint,
  model,
  overflow,
  admitFn = admit,
  burstEndpointFn = getAvailableBurstEndpoint,
} = {}) {
  if (overflow == null) return { endpoint, model, overflowed: false };
  if (overflow !== 'burst') {
    throw new Error(`Unsupported --overflow target "${overflow}"; only "burst" is available`);
  }
  if (isBurstEndpoint(endpoint)) return { endpoint, model, overflowed: false };
  const localPlan = await admitFn(endpoint, model, { dryRun: true });
  if (localPlan.ok) {
    return { endpoint, model, overflowed: false, admission: localPlan };
  }
  const burst = await burstEndpointFn();
  if (!burst) {
    return {
      endpoint: null,
      model,
      overflowed: true,
      unavailable: true,
      reason: AIOD_INSTALL_HINT,
      admission: localPlan,
    };
  }
  return { endpoint: burst, model, overflowed: true, admission: localPlan };
}

async function currentBurstWarning() {
  const current = await burstStatus();
  if (!current.available) return null;
  return burstWarning(current)
    ?? (current.statusUnknown
      ? `!!! BURST BILLING STATUS UNKNOWN — ${current.error ?? 'run "local-llm burst status" and check the provider console'} !!!`
      : null);
}

async function printCurrentBurstWarning({ json = false } = {}) {
  const warning = await currentBurstWarning();
  if (!warning) return;
  (json ? process.stderr : process.stdout).write(`${warning}\n`);
}

function burstStatusResult(current) {
  return {
    running: current.running,
    serving: current.serving,
    state: current.state,
    instanceId: current.instanceId ?? null,
    model: current.model,
    gpu: current.gpu,
    endpoint: current.baseUrl,
    pricePerHour: current.pricePerHour,
    costSoFar: current.costSoFar,
    idleRemainingMinutes: current.idleRemaining,
    ttlRemainingHours: current.ttlRemaining,
  };
}

function printBurstStatus(current) {
  const warning = burstWarning(current);
  if (warning) process.stdout.write(`${warning}\n`);
  if (current.statusUnknown) {
    process.stdout.write(
      `!!! BURST BILLING STATUS UNKNOWN — ${current.error ?? 'check the provider console immediately'} !!!\n`,
    );
    return;
  }
  if (!current.running) {
    process.stdout.write('No burst instance live; nothing is billing.\n');
    return;
  }
  process.stdout.write(
    [
      `State:              ${current.state ?? '?'}`,
      `Model:              ${current.model ?? '?'}`,
      `GPU:                ${current.gpu ?? '?'}`,
      `Endpoint:           ${current.baseUrl ?? 'not serving yet'}`,
      `Price:              ${current.pricePerHour == null ? '?' : `$${current.pricePerHour.toFixed(2)}/hr`}`,
      `Cost so far:        ${current.costSoFar == null ? '?' : `$${current.costSoFar.toFixed(2)}`}`,
      `Idle remaining:     ${current.idleRemaining == null ? '?' : `${current.idleRemaining.toFixed(1)}m`}`,
      `TTL remaining:      ${current.ttlRemaining == null ? '?' : `${current.ttlRemaining.toFixed(2)}h`}`,
    ].join('\n') + '\n',
  );
}

async function burstCommand(options, args) {
  if (args.length !== 1 || !['status', 'up', 'down'].includes(args[0])) {
    throw new Error('burst requires exactly one subcommand: status, up, or down');
  }
  const [subcommand] = args;
  if (subcommand === 'status') {
    // Proxy-first status can still reveal an actively billing instance if the
    // local aiod executable was removed after launch.
    const current = await burstStatus();
    if (!current.available) {
      process.stdout.write(`${AIOD_INSTALL_HINT}\n`);
      return 0;
    }
    if (options.json) {
      const warning = burstWarning(current)
        ?? (current.statusUnknown
          ? `!!! BURST BILLING STATUS UNKNOWN — ${current.error ?? 'check the provider console immediately'} !!!`
          : null);
      if (warning) process.stderr.write(`${warning}\n`);
      writeJson(burstStatusResult(current));
    } else {
      printBurstStatus(current);
    }
    return 0;
  }
  const endpoint = await getAvailableBurstEndpoint();
  if (!endpoint) {
    process.stdout.write(`${AIOD_INSTALL_HINT}\n`);
    return 0;
  }
  if (subcommand === 'down') {
    const result = await teardownBurst({ binary: endpoint.binary });
    if (options.json) writeJson(result);
    else process.stdout.write(result.destroyed ? 'Burst instance destroyed; billing stopped.\n' : 'No burst instance was tracked.\n');
    return 0;
  }

  const controller = new AbortController();
  const interrupts = installInterruptHandlers(controller);
  try {
    const activated = await activateBurstEndpoint(endpoint, options, {
      signal: controller.signal,
      proposalOnly: Boolean(options.dryRun),
    });
    if (activated.proposed) {
      if (options.dryRun) {
        process.stdout.write('Dry run: burst plan proposed; nothing rented.\n');
        return 0;
      }
      process.stderr.write('Burst not started: this invocation was not confirmed.\n');
      return 1;
    }
    const current = activated.endpoint.status;
    if (options.json) writeJson(burstStatusResult(current));
    else printBurstStatus(current);
    return 0;
  } finally {
    interrupts.remove();
  }
}

async function runBurstOneShot(command, endpoint, options, args) {
  if (['ask', 'plan', 'bench'].includes(command)) {
    requireRemoteDataOptIn(endpoint, options.allowRemoteData);
  }
  const controller = new AbortController();
  const interrupts = installInterruptHandlers(controller);
  let workingEndpoint = endpoint;
  let shouldTeardown = false;
  try {
    const activated = await activateBurstEndpoint(endpoint, options, {
      signal: controller.signal,
    });
    if (activated.proposed) {
      process.stderr.write('Burst not started: this invocation was not confirmed.\n');
      return 1;
    }
    workingEndpoint = activated.endpoint;
    shouldTeardown = true;
    switch (command) {
      case 'ask':
        await askCommand(workingEndpoint, options, args, controller.signal);
        return 0;
      case 'plan':
        await planCommand(workingEndpoint, options, args, controller.signal);
        return 0;
      case 'bench':
        if (args.length > 0) throw new Error('bench takes no positional arguments');
        await benchCommand(workingEndpoint, options, controller.signal);
        return 0;
      default:
        throw new Error(`Command "${command}" is not a burst one-shot command`);
    }
  } finally {
    try {
      if (shouldTeardown) {
        await teardownBurst({ binary: workingEndpoint.binary });
      }
    } finally {
      interrupts.remove();
    }
  }
}

async function endpointsCommand(options) {
  const endpoints = await listEndpoints();
  const rows = await Promise.all(endpoints.map(async (endpoint) => {
    const provider = resolve(endpoint);
    let reachable = false;
    try {
      await Promise.race([
        provider.listModels(endpoint),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timed out')), 1_500)),
      ]);
      reachable = true;
    } catch {
      reachable = false;
    }
    return {
      id: endpoint.id,
      kind: provider.kind,
      baseUrl: endpoint.baseUrl,
      reachable,
      capabilities: provider.capabilities,
    };
  }));

  if (options.json) {
    writeJson(rows);
    return;
  }
  printRows(rows, [
    { label: 'ID', value: (row) => row.id },
    { label: 'KIND', value: (row) => row.kind },
    { label: 'URL', value: (row) => row.baseUrl },
    { label: 'REACHABLE', value: (row) => (row.reachable ? 'yes' : 'no') },
    {
      label: 'CAPABILITIES',
      value: (row) => Object.entries(row.capabilities)
        .filter(([, supported]) => supported)
        .map(([name]) => name)
        .join(' '),
    },
  ]);
}

async function modelsCommand(endpoint, options) {
  if (options.checkUpdates) {
    const result = await checkUpdates(endpoint, options);
    if (options.json) {
      writeJson(result);
      return;
    }
    if (!result.ok) {
      process.stdout.write(`${result.message}\n`);
      return;
    }
    process.stdout.write(`Endpoint: ${endpoint.id} (${endpoint.baseUrl})\n`);
    process.stdout.write(`Updates: ${result.disclaimer}\n`);
    if (result.cached) process.stdout.write('(served from 24h cache)\n');
    printRows(result.updates, [
      { label: 'MODEL', value: (row) => row.id },
      { label: 'STATUS', value: (row) => row.status },
      { label: 'FORMAT', value: (row) => row.format },
      { label: 'QUANT', value: (row) => row.quant },
      { label: 'SIZE', value: (row) => roundGb(row.sizeGb) },
      { label: 'DOWNLOADS', value: (row) => String(row.downloads) },
      {
        label: 'INSTALLED',
        value: (row) => (row.status === 'newer-quant'
          ? `${row.installedId} (${row.installedQuant ?? 'unknown quant'})`
          : '-'),
      },
    ]);
    return;
  }

  let models = await resolve(endpoint).listModels(endpoint);
  if (options.class) {
    const preferred = JOB_CLASSES[options.class];
    if (!preferred) {
      throw new Error(
        `Unknown job class "${options.class}". Available classes: ${Object.keys(JOB_CLASSES).join(', ')}`,
      );
    }
    const order = new Map(preferred.map((id, index) => [id, index]));
    models = models
      .filter((model) => order.has(model.id))
      .sort((left, right) => order.get(left.id) - order.get(right.id));
  }

  if (options.fit) {
    const assessed = [];
    for (const model of models) {
      const admission = await admit(endpoint, model.id, { dryRun: true });
      if (admission.ok) assessed.push({ ...model, admission });
    }
    models = assessed;
  }

  if (options.json) {
    writeJson(models);
    return;
  }
  process.stdout.write(`Endpoint: ${endpoint.id} (${endpoint.baseUrl})\n`);
  printRows(models, [
    { label: 'MODEL', value: (row) => row.id },
    { label: 'TYPE', value: (row) => row.type },
    { label: 'STATE', value: (row) => row.state },
    { label: 'SIZE', value: (row) => row.sizeGb == null ? '?' : roundGb(row.sizeGb) },
    {
      label: 'ADMISSION',
      value: (row) => row.admission?.action ?? '-',
    },
  ]);
}

async function psCommand(endpoint, options) {
  if (!options.burstWarningPrinted) await printCurrentBurstWarning(options);
  const report = await budget(endpoint);
  const result = { loaded: report.loaded, budget: withoutLoaded(report) };
  if (options.json) {
    writeJson(result);
    return;
  }
  process.stdout.write(`Endpoint: ${endpoint.id} (${endpoint.baseUrl})\n`);
  printRows(report.loaded, [
    { label: 'IDENTIFIER', value: (row) => row.identifier },
    { label: 'MODEL', value: (row) => row.model },
    { label: 'SIZE', value: (row) => (row.sizeGb == null ? '?' : roundGb(row.sizeGb)) },
    { label: 'CONTEXT', value: (row) => row.context },
    { label: 'PARALLEL', value: (row) => row.parallel },
  ]);
  process.stdout.write(
    report.managed === false
      ? 'memory: unmanaged (this backend does not report model sizes)\n'
      : `Memory: ${roundGb(report.usedGb)} used / ${roundGb(report.budgetGb)} budget (${roundGb(report.freeGb)} free)\n`,
  );
}

async function budgetCommand(endpoint, options) {
  if (!options.burstWarningPrinted) await printCurrentBurstWarning(options);
  const report = await budget(endpoint);
  if (options.json) {
    writeJson(report);
    return;
  }
  process.stdout.write(`Endpoint: ${endpoint.id} (${endpoint.baseUrl})\n`);
  process.stdout.write(
    [
      `Total unified memory: ${roundGb(report.totalGb)}`,
      `GPU wired ceiling:   ${roundGb(report.ceilingGb)}`,
      `OS/app reserve:      ${roundGb(report.reserveGb)}`,
      `Inference budget:    ${roundGb(report.budgetGb)}`,
      ...(report.managed === false
        ? ['memory: unmanaged (this backend does not report model sizes)']
        : [
          `Loaded models:       ${roundGb(report.usedGb)}`,
          `Free budget:         ${roundGb(report.freeGb)}`,
        ]),
    ].join('\n') + '\n',
  );
}

async function askCommand(endpoint, options, promptParts, signal) {
  const prompt = promptParts.join(' ');
  const result = await ask({
    endpoint,
    prompt,
    class: options.class,
    model: options.model,
    uncensored: options.uncensored,
    reasoningEffort: options.reasoningEffort,
    allowRemoteData: options.allowRemoteData,
    signal,
  });
  if (options.json) writeJson(result);
  else process.stdout.write(`${result.response ?? ''}\n`);
}

async function resolveBatchModel(endpoint, options) {
  if (options.model) return options.model;
  const selected = await selectModel({
    class: options.uncensored ? 'security' : (options.class ?? 'workhorse'),
    endpoint,
  });
  return selected.id;
}

function validateBatchTemplates(items, template) {
  for (let index = 0; index < items.length; index += 1) {
    substituteTemplate(template, items[index], items[index][ITEM_LINE] ?? index + 1);
  }
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const seconds = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function estimateBurstBatchMinutes(items, template) {
  if (items.length === 0) return 1;
  let promptTokens = 0;
  for (let index = 0; index < items.length; index += 1) {
    const rendered = substituteTemplate(
      template,
      items[index],
      items[index][ITEM_LINE] ?? index + 1,
    );
    promptTokens += Math.max(1, Math.ceil(rendered.length / 4));
  }
  // Explicitly an assumption, used only to put an estimated runtime/cost in
  // front of the confirmation gate. Measured planning remains `local-llm plan`.
  const assumedCompletionTokens = 300 * items.length;
  const assumedAggregateTokensPerSecond = 340;
  return Math.max(1, (promptTokens + assumedCompletionTokens) / assumedAggregateTokensPerSecond / 60);
}

async function batchCommand(endpoint, options, inputFiles) {
  if (inputFiles.length !== 1) {
    throw new Error('batch requires exactly one input file');
  }
  if (Boolean(options.template) === Boolean(options.prompt)) {
    throw new Error('batch requires exactly one of --template <file> or --prompt <text>');
  }

  const input = inputFiles[0];
  const template = options.template
    ? await readFile(options.template, 'utf8')
    : options.prompt;
  const system = options.system == null ? undefined : await fileOrLiteral(options.system);
  const items = await readItems(input, { field: options.field });
  validateBatchTemplates(items, template);
  const out = options.out ?? defaultOutputPath(input);
  let workingEndpoint = endpoint;
  let model = null;
  if (options.overflow != null && !isBurstEndpoint(workingEndpoint)) {
    model = await resolveBatchModel(workingEndpoint, options);
    const selected = await selectOverflowEndpoint({
      endpoint: workingEndpoint,
      model,
      overflow: options.overflow,
    });
    if (selected.unavailable) {
      process.stdout.write(`${selected.reason}\n`);
      return 0;
    }
    workingEndpoint = selected.endpoint;
  } else if (options.overflow != null && options.overflow !== 'burst') {
    throw new Error(`Unsupported --overflow target "${options.overflow}"; only "burst" is available`);
  }

  const burst = isBurstEndpoint(workingEndpoint);
  if (burst && !options.dryRun) {
    // Check before provisioning: permission discovered after spin would still
    // spend money, even though the items were ultimately refused.
    requireRemoteDataOptIn(workingEndpoint, options.allowRemoteData);
  }
  const controller = new AbortController();
  const interrupts = installInterruptHandlers(controller);
  let renderedProgress = false;
  let shouldTeardown = false;
  let summary;
  try {
    if (burst) {
      const activated = await activateBurstEndpoint(workingEndpoint, options, {
        estimatedRuntimeMinutes: estimateBurstBatchMinutes(items, template),
        model,
        signal: controller.signal,
        proposalOnly: Boolean(options.dryRun),
      });
      if (activated.proposed) {
        if (options.dryRun) {
          process.stdout.write('Dry run: burst plan proposed; nothing rented and no data sent.\n');
          return 0;
        }
        process.stderr.write('Burst not started: this invocation was not confirmed.\n');
        return 1;
      }
      workingEndpoint = activated.endpoint;
      // A dry-run never owns an already-live instance and must not destroy it.
      shouldTeardown = !options.dryRun;
    }

    model = options.model ?? model ?? workingEndpoint.model;
    if (!model) model = await resolveBatchModel(workingEndpoint, options);
    const admission = await admit(workingEndpoint, model, {
      dryRun: Boolean(options.dryRun),
    });
    if (!admission.ok) {
      throw new Error(`Cannot admit model "${model}": ${admission.reason}`);
    }

    if (options.dryRun) {
      const result = { model, items: items.length, out, admission };
      if (options.json) writeJson(result);
      else {
        process.stdout.write(
          `Dry run: ${items.length} items with ${model}; admission action: ${admission.action}; output: ${out}\n`,
        );
      }
      return 0;
    }

    summary = await runBatch({
      endpoint: workingEndpoint,
      model,
      template,
      system,
      items,
      out,
      concurrency: options.concurrency,
      reasoningEffort: options.reasoningEffort,
      allowed: options.allow
        ? String(options.allow).split(',').map((v) => v.trim()).filter(Boolean)
        : null,
      restart: options.restart,
      signal: controller.signal,
      allowRemoteData: options.allowRemoteData,
      onProgress: options.json
        ? undefined
        : (progress) => {
          renderedProgress = true;
          process.stderr.write(
            `\r${progress.done}/${progress.total}  ok ${progress.ok}  failed ${progress.failed}  ETA ${formatDuration(progress.etaMs)}  ${progress.tokensPerSec.toFixed(1)} tok/s`,
          );
        },
    });
  } finally {
    try {
      if (renderedProgress) process.stderr.write('\n');
      if (shouldTeardown) {
        await teardownBurst({ binary: workingEndpoint.binary });
      }
    } finally {
      interrupts.remove();
    }
  }

  if (options.json) writeJson({ model, ...summary });
  else {
    process.stdout.write(
      `Batch complete: ${summary.done}/${summary.total}, ${summary.ok} ok, ${summary.failed} failed. Output: ${out}\n`,
    );
  }
  if (interrupts.signal || summary.stopped) {
    process.stderr.write(`Stopped safely. Resume with the same command and --out ${out}\n`);
    return interrupts.signal === 'SIGTERM' ? 143 : 130;
  }
  return 0;
}

function formatSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '?';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return `~${hours}h ${minutes}m`;
  if (minutes > 0) return `~${minutes}m ${total % 60}s`;
  return `~${total}s`;
}

async function planCommand(endpoint, options, args, signal) {
  if (args.length !== 1) throw new Error('plan requires exactly one input file');
  if (Boolean(options.template) === Boolean(options.prompt)) {
    throw new Error('plan requires exactly one of --template <file> or --prompt <text>');
  }
  let timingSampleSize;
  if (options.sample != null) {
    timingSampleSize = Number(options.sample);
    if (!Number.isInteger(timingSampleSize) || timingSampleSize <= 0) {
      throw new Error(`--sample requires a positive integer; received "${options.sample}"`);
    }
  }
  const template = options.template
    ? await readFile(options.template, 'utf8')
    : options.prompt;
  const items = await readItems(args[0], { field: options.field });
  const model = await resolveBatchModel(endpoint, options);
  const plan = await planBatch({
    endpoint,
    model,
    template,
    items,
    allowed: options.allow
      ? String(options.allow).split(',').map((v) => v.trim()).filter(Boolean)
      : null,
    reasoningEffort: options.reasoningEffort,
    allowRemoteData: options.allowRemoteData,
    signal,
    sample: !options.noSample,
    ...(timingSampleSize == null ? {} : { timingSampleSize }),
  });
  let comparison = null;
  if (!isBurstEndpoint(endpoint)) {
    try {
      const candidate = await getAvailableBurstEndpoint();
      if (candidate) {
        const profile = options.profile ?? candidate.profile ?? 'qwen3-coder-30b';
        const cached = await readThroughput();
        const measured = [
          candidate.model,
          profile,
        ]
          .filter(Boolean)
          .map((id) => cached[throughputKey('burst', id)])
          .find((entry) => (
            entry?.warning == null
            && Number.isFinite(Number(entry?.aggregateTokPerSec))
            && Number(entry.aggregateTokPerSec) > 0
          ));
        const tokPerSec = measured
          ? Number(measured.aggregateTokPerSec)
          : ASSUMED_BURST_TOK_PER_SEC;
        const rateSource = measured
          ? `measured (bench ${measured.measuredAt ?? 'earlier'})`
          : `assumed default (${ASSUMED_BURST_TOK_PER_SEC} tok/s aggregate)`;
        const estimatedRuntimeMinutes = Math.max(1 / 60, plan.totalTokens / tokPerSec / 60);
        const proposal = await proposeBurst(
          {
            profile,
            quant: options.quant ?? candidate.quant ?? 'fp8',
            maxPrice: numericOption(options, 'maxPrice') ?? candidate.maxPricePerHour ?? 3,
            // Planning is read-only and cannot spin. These are stated launch
            // assumptions for costing the proposal, never saved defaults.
            idle: numericOption(options, 'idle', { integer: true }) ?? 20,
            ttl: numericOption(options, 'ttl') ?? 2,
            estimatedRuntimeMinutes,
          },
          { binary: candidate.binary, signal },
        );
        if (proposal.available) {
          comparison = buildBurstComparison(plan, proposal.plan, {
            tokPerSec,
            rateSource,
          });
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // A comparison is optional when aiod or its offer source is currently
      // unavailable. The local plan remains useful and burst simply does not
      // appear, matching optional endpoint discovery.
    }
  }

  if (options.json) {
    writeJson(comparison == null ? plan : { ...plan, comparison });
    return;
  }
  process.stdout.write(
    [
      `Plan for ${plan.items} item(s) with ${plan.model} on endpoint "${plan.endpoint}"`,
      `  prompt tokens/item:  ${plan.sample.promptTokensPerItem.toFixed(0)} (${plan.sample.source}; sampled ${plan.sample.sampled} items)`,
      `  completion/item:     ${plan.completionTokensPerItem.value} (${plan.completionTokensPerItem.source})`,
      `  aggregate rate:      ${plan.rate.tokPerSec.toFixed(1)} tok/s (${plan.rate.source})`,
      `  total tokens:        ~${Math.round(plan.totalTokens).toLocaleString('en-US')}`,
      `  ETA:                 ${formatSeconds(plan.etaSeconds)} (${plan.etaMethod})`,
    ].join('\n') + '\n',
  );
  if (comparison) {
    const saved = comparison.timeSavedSeconds == null
      ? null
      : Math.max(0, comparison.timeSavedSeconds);
    process.stdout.write(
      [
        '',
        'Local vs burst (all time and cost figures are estimates)',
        `  local  ${comparison.local.model}  ${formatSeconds(comparison.local.etaSeconds)}  $0.00`,
        `         basis: ${comparison.local.basis}`,
        `  burst  ${comparison.burst.model} on ${comparison.burst.gpu}  ${formatSeconds(comparison.burst.etaSeconds)}  ~$${comparison.burst.estimatedCost.toFixed(2)}`,
        `         ${comparison.burst.tokPerSec.toFixed(1)} tok/s aggregate (${comparison.burst.rateSource}); $${comparison.burst.pricePerHour.toFixed(2)}/hr`,
        `         planning limits: idle ${comparison.burst.idleMinutes}m, TTL ${comparison.burst.ttlHours}h`,
        ...(saved == null
          ? []
          : [`  → burst saves ${formatSeconds(saved)} for about $${comparison.burst.estimatedCost.toFixed(2)} (estimate)`]),
      ].join('\n') + '\n',
    );
  }
}

function positiveIntegerOption(options, name) {
  if (options[name] == null) return undefined;
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} requires a positive integer; received "${options[name]}"`);
  }
  return value;
}

async function benchCommand(endpoint, options, signal) {
  const model = await resolveBatchModel(endpoint, options);
  const maxTokens = positiveIntegerOption(options, 'maxTokens');
  const runs = positiveIntegerOption(options, 'runs');
  const result = await runBench({
    endpoint,
    model,
    maxTokens,
    runs,
    allowRemoteData: options.allowRemoteData,
    signal,
  });
  const cachePath = await recordThroughput(result);

  if (options.json) {
    writeJson({ ...result, throughputPath: cachePath });
    return;
  }
  process.stdout.write(
    [
      `Bench of ${result.model} on endpoint "${result.endpoint}"`,
      `  model load:          ${result.loadSeconds.toFixed(1)} s`,
      `  single stream:       ${result.singleTokPerSec.toFixed(1)} tok/s (mean of ${result.runs} run(s) at ${result.maxTokens} max tokens)`,
      `  ${result.concurrency}-way aggregate:  ${result.aggregateTokPerSec.toFixed(1)} tok/s (measured)`,
      `  prefill (prompt):    ${result.promptTokPerSec.toFixed(1)} tok/s`,
      `  decode (completion): ${result.completionTokPerSec.toFixed(1)} tok/s`,
      `  end-to-end:          ${result.itemsPerSec.toFixed(2)} items/s at ${result.concurrency}-way concurrency`,
      ...(result.warning ? [`  WARNING: ${result.warning}`] : []),
      `  recorded to ${cachePath}`,
    ].join('\n') + '\n',
  );
}

async function loadCommand(endpoint, options, args) {
  if (args.length !== 1) throw new Error('load requires exactly one model id');
  const plan = await admit(endpoint, args[0], { dryRun: Boolean(options.dryRun) });
  if (!plan.ok) throw new Error(`Cannot admit model "${args[0]}": ${plan.reason}`);
  if (options.json) writeJson(plan);
  else process.stdout.write(`${options.dryRun ? 'Dry run: ' : ''}${plan.reason}\n`);
}

async function unloadCommand(endpoint, options, args) {
  if (options.all && args.length > 0) {
    throw new Error('unload accepts either an identifier or --all, not both');
  }
  if (!options.all && args.length !== 1) {
    throw new Error('unload requires an identifier or --all');
  }
  const provider = resolve(endpoint);
  const identifiers = options.all
    ? (await provider.ps(endpoint)).map((entry) => entry.identifier)
    : args;
  for (const identifier of identifiers) await provider.unload(endpoint, identifier);
  const result = { unloaded: identifiers };
  if (options.json) writeJson(result);
  else process.stdout.write(
    identifiers.length > 0 ? `Unloaded: ${identifiers.join(', ')}\n` : 'No models were loaded\n',
  );
}

async function pinsCommand(endpoint, options, command, args) {
  let pins;
  if (command === 'pins') {
    if (args.length > 0) throw new Error('pins takes no model id');
    pins = await listPins(endpoint);
  } else {
    if (args.length !== 1) throw new Error(`${command} requires exactly one model id`);
    pins = command === 'pin'
      ? await pinModel(endpoint, args[0])
      : await unpinModel(endpoint, args[0]);
  }
  if (options.json) writeJson(pins);
  else process.stdout.write(pins.length > 0 ? `${pins.join('\n')}\n` : 'No pinned models\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { options, positionals } = parseArgs(argv);
  if (options.reasoningEffort != null) {
    options.reasoningEffort = validateReasoningEffort(options.reasoningEffort);
  }
  if (options.version) {
    if (options.json) writeJson({ version: VERSION });
    else process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const [command, ...args] = positionals;
  if (command === 'burst') {
    return burstCommand(options, args);
  }
  if (command === 'status') {
    if (args.length > 0) throw new Error('status takes no positional arguments');
    const current = await burstStatus();
    if (!current.available) {
      if (options.json) writeJson({ burst: { available: false, running: false } });
      else process.stdout.write('No burst instance live; aiod is not installed.\n');
      return 0;
    }
    if (options.json) {
      const warning = burstWarning(current)
        ?? (current.statusUnknown
          ? `!!! BURST BILLING STATUS UNKNOWN — ${current.error ?? 'check the provider console immediately'} !!!`
          : null);
      if (warning) process.stderr.write(`${warning}\n`);
      writeJson({ burst: burstStatusResult(current) });
    } else {
      printBurstStatus(current);
    }
    return 0;
  }
  // `endpoints` reports on the whole registry, so it must not require a
  // resolvable default endpoint first.
  if (command === 'endpoints') {
    if (args.length > 0) throw new Error('endpoints takes no positional arguments');
    await endpointsCommand(options);
    return 0;
  }
  // Billing visibility must not depend on the free/local endpoint registry
  // being healthy. Print this before default endpoint resolution.
  if (command === 'ps' || command === 'budget') {
    await printCurrentBurstWarning(options);
    options.burstWarningPrinted = true;
  }
  let endpoint;
  if (options.endpoint === 'burst') {
    endpoint = await getAvailableBurstEndpoint();
    if (!endpoint) {
      process.stdout.write(`${AIOD_INSTALL_HINT}\n`);
      return 0;
    }
  } else {
    endpoint = await chooseEndpoint(options.endpoint);
  }
  if (isBurstEndpoint(endpoint) && ['ask', 'plan', 'bench'].includes(command)) {
    return runBurstOneShot(command, endpoint, options, args);
  }
  switch (command) {
    case 'models':
      if (args.length > 0) throw new Error('models takes no positional arguments');
      await modelsCommand(endpoint, options);
      return 0;
    case 'ps':
      if (args.length > 0) throw new Error('ps takes no positional arguments');
      await psCommand(endpoint, options);
      return 0;
    case 'budget':
      if (args.length > 0) throw new Error('budget takes no positional arguments');
      await budgetCommand(endpoint, options);
      return 0;
    case 'ask':
      await askCommand(endpoint, options, args);
      return 0;
    case 'batch':
      return batchCommand(endpoint, options, args);
    case 'plan':
      await planCommand(endpoint, options, args);
      return 0;
    case 'bench':
      if (args.length > 0) throw new Error('bench takes no positional arguments');
      await benchCommand(endpoint, options);
      return 0;
    case 'load':
      await loadCommand(endpoint, options, args);
      return 0;
    case 'unload':
      await unloadCommand(endpoint, options, args);
      return 0;
    case 'pin':
    case 'unpin':
    case 'pins':
      await pinsCommand(endpoint, options, command, args);
      return 0;
    default:
      throw new Error(`Unknown command "${command}". Run local-llm --help for usage.`);
  }
}

// Resolve argv[1] through any symlinks before comparing. Installed CLIs are
// almost always reached via a link — `npm link`, a package manager shim, or a
// hand-made symlink in ~/.local/bin — and in that case argv[1] is the LINK
// path while import.meta.url is the REAL path. Comparing them unresolved makes
// this check false, so main() never runs: the command exits 0 and prints
// nothing, which looks like success everywhere it is tested.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved = entry;
  try {
    resolved = realpathSync(entry);
  } catch {
    /* not a real path (e.g. a virtual entry) — fall back to the raw value */
  }
  return import.meta.url === pathToFileURL(resolved).href;
})();
if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const json = process.argv.includes('--json');
    if (json) process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    else process.stderr.write(`local-llm: ${error.message}\n`);
    process.exitCode = 1;
  }
}
