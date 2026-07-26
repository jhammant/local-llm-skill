#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getEndpoint, defaultEndpoint } from './endpoints.mjs';
import * as lmstudio from './lmstudio.mjs';
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
import { planBatch } from './plan.mjs';
import { recordThroughput, runBench } from './bench.mjs';

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
]);
const BOOLEAN_OPTIONS = new Set([
  'json',
  'fit',
  'uncensored',
  'restart',
  'dry-run',
  'all',
  'no-sample',
  'help',
  'version',
]);

const HELP = `local-llm ${VERSION}

Usage:
  local-llm models [--fit] [--class <c>] [--json]
  local-llm ps [--json]
  local-llm budget [--json]
  local-llm ask <prompt…> [--class c] [--model m] [--uncensored]
      [--reasoning-effort e] [--json]
  local-llm batch <items.jsonl> (--template f | --prompt s) [--out f]
      [--class c] [--model m] [--field name] [--system f]
      [--concurrency n] [--allow a,b,c] [--reasoning-effort e]
      [--restart] [--dry-run] [--json]
  local-llm plan <items.jsonl> (--template f | --prompt s)
      [--class c] [--model m] [--field name] [--allow a,b,c]
      [--reasoning-effort e] [--sample n] [--no-sample] [--json]
  local-llm bench [--model m] [--class c] [--max-tokens n] [--runs n] [--json]
  local-llm load <model> [--dry-run] [--json]
  local-llm unload <identifier | --all> [--json]
  local-llm pin <model> | unpin <model> | pins [--json]
  local-llm --version

Global:
  --endpoint <id>   endpoint registry id (default: configured local endpoint)
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

async function modelsCommand(endpoint, options) {
  let models = await lmstudio.listModels(endpoint);
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
  const report = await budget(endpoint);
  const result = { loaded: report.loaded, budget: withoutLoaded(report) };
  if (options.json) {
    writeJson(result);
    return;
  }
  printRows(report.loaded, [
    { label: 'IDENTIFIER', value: (row) => row.identifier },
    { label: 'MODEL', value: (row) => row.model },
    { label: 'SIZE', value: (row) => roundGb(row.sizeGb) },
    { label: 'CONTEXT', value: (row) => row.context },
    { label: 'PARALLEL', value: (row) => row.parallel },
  ]);
  process.stdout.write(
    `Memory: ${roundGb(report.usedGb)} used / ${roundGb(report.budgetGb)} budget (${roundGb(report.freeGb)} free)\n`,
  );
}

async function budgetCommand(endpoint, options) {
  const report = await budget(endpoint);
  if (options.json) {
    writeJson(report);
    return;
  }
  process.stdout.write(
    [
      `Total unified memory: ${roundGb(report.totalGb)}`,
      `GPU wired ceiling:   ${roundGb(report.ceilingGb)}`,
      `OS/app reserve:      ${roundGb(report.reserveGb)}`,
      `Inference budget:    ${roundGb(report.budgetGb)}`,
      `Loaded models:       ${roundGb(report.usedGb)}`,
      `Free budget:         ${roundGb(report.freeGb)}`,
    ].join('\n') + '\n',
  );
}

async function askCommand(endpoint, options, promptParts) {
  const prompt = promptParts.join(' ');
  const result = await ask({
    endpoint,
    prompt,
    class: options.class,
    model: options.model,
    uncensored: options.uncensored,
    reasoningEffort: options.reasoningEffort,
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
  const model = await resolveBatchModel(endpoint, options);
  const admission = await admit(endpoint, model, { dryRun: Boolean(options.dryRun) });
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

  const controller = new AbortController();
  let interrupted = false;
  let renderedProgress = false;
  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  let summary;
  try {
    summary = await runBatch({
      endpoint,
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
    process.removeListener('SIGINT', onSigint);
    if (renderedProgress) process.stderr.write('\n');
  }

  if (options.json) writeJson({ model, ...summary });
  else {
    process.stdout.write(
      `Batch complete: ${summary.done}/${summary.total}, ${summary.ok} ok, ${summary.failed} failed. Output: ${out}\n`,
    );
  }
  if (interrupted || summary.stopped) {
    process.stderr.write(`Stopped safely. Resume with the same command and --out ${out}\n`);
    return 130;
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

async function planCommand(endpoint, options, args) {
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
    sample: !options.noSample,
    ...(timingSampleSize == null ? {} : { timingSampleSize }),
  });

  if (options.json) {
    writeJson(plan);
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
}

function positiveIntegerOption(options, name) {
  if (options[name] == null) return undefined;
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} requires a positive integer; received "${options[name]}"`);
  }
  return value;
}

async function benchCommand(endpoint, options) {
  const model = await resolveBatchModel(endpoint, options);
  const maxTokens = positiveIntegerOption(options, 'maxTokens');
  const runs = positiveIntegerOption(options, 'runs');
  const result = await runBench({ endpoint, model, maxTokens, runs });
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
  const identifiers = options.all
    ? (await lmstudio.ps(endpoint)).map((entry) => entry.identifier)
    : args;
  for (const identifier of identifiers) await lmstudio.unload(endpoint, identifier);
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
    options.reasoningEffort = lmstudio.validateReasoningEffort(options.reasoningEffort);
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
  const endpoint = await chooseEndpoint(options.endpoint);
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
