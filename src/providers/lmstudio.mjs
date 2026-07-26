// LM Studio provider. Discovery is HTTP (/api/v0/models); sizes, loaded
// state, load and unload come from the `lms` CLI when the endpoint is under
// CLI control. Chat and embeddings ride the shared OpenAI-compatible client.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestJson, requireEndpoint } from './http.mjs';

export {
  chat,
  embed,
  validateReasoningEffort,
  REASONING_EFFORTS,
} from './http.mjs';

export const kind = 'lmstudio';
export const capabilities = Object.freeze({
  sizes: true,
  loadedState: true,
  load: true,
  unload: true,
  embed: true,
  toolInfo: true,
});

const ANSI_PATTERN = [
  '[\\u001B\\u009B][[\\]()#;?]*(?:',
  '(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|',
  '(?:[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?)?\\u0007)',
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join('');
const ANSI_RE = new RegExp(ANSI_PATTERN, 'g');
const SIZE_RE = /^(\d+(?:\.\d+)?)$/;
const SIZE_UNITS = new Map([
  ['KB', 1 / (1024 * 1024)],
  ['MB', 1 / 1024],
  ['GB', 1],
  ['TB', 1024],
]);

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_RE, '');
}

function toGb(value, unit) {
  const factor = SIZE_UNITS.get(String(unit).toUpperCase());
  return factor == null ? null : Number(value) * factor;
}

function parseFlexibleInteger(value) {
  const match = String(value ?? '').match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return null;
  const multiplier = match[2]?.toLowerCase() === 'k'
    ? 1_000
    : match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

export function parsePsOutput(output) {
  const clean = stripAnsi(output);
  if (/No models are currently loaded/i.test(clean)) return [];

  const rows = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+\s*/, '');
    if (!line || /^IDENTIFIER\s+/i.test(line)) continue;
    const columns = line.split(/\s+/);
    const sizeIndex = columns.findIndex(
      (column, index) => SIZE_RE.test(column) && SIZE_UNITS.has(columns[index + 1]?.toUpperCase()),
    );
    if (sizeIndex < 3 || columns.length < sizeIndex + 4) continue;

    const sizeGb = toGb(columns[sizeIndex], columns[sizeIndex + 1]);
    const context = parseFlexibleInteger(columns[sizeIndex + 2]);
    const parallel = parseFlexibleInteger(columns[sizeIndex + 3]);
    if (sizeGb == null || context == null || parallel == null) continue;

    rows.push({
      identifier: columns[0],
      model: columns[1],
      status: columns.slice(2, sizeIndex).join(' '),
      sizeGb,
      context,
      parallel,
    });
  }
  return rows;
}

export function parseLsOutput(output) {
  const sizes = new Map();
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+\s*/, '');
    if (!line) continue;
    const columns = line.split(/\s+/);
    const sizeIndex = columns.findIndex(
      (column, index) => SIZE_RE.test(column) && SIZE_UNITS.has(columns[index + 1]?.toUpperCase()),
    );
    if (sizeIndex < 1) continue;
    const sizeGb = toGb(columns[sizeIndex], columns[sizeIndex + 1]);
    if (sizeGb != null) sizes.set(columns[0], sizeGb);
  }
  return sizes;
}

function execute(file, args, options = {}) {
  const execFileFn = options.execFileFn ?? execFile;
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout = '', stderr = '') => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function isExecutable(path, options = {}) {
  try {
    await (options.accessFn ?? access)(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
}

export async function resolveLms(options = {}) {
  if (process.env.LMS_BIN) {
    const configured = expandHome(process.env.LMS_BIN);
    if (await isExecutable(configured, options)) return configured;
    throw new Error(`LMS_BIN points to a missing or non-executable file: ${configured}`);
  }

  try {
    const { stdout } = await execute('which', ['lms'], options);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found && await isExecutable(found, options)) return found;
  } catch {
    // The documented LM Studio install location is checked next.
  }

  const installed = join(homedir(), '.lmstudio', 'bin', 'lms');
  if (await isExecutable(installed, options)) return installed;
  throw new Error(
    `Could not find the LM Studio CLI. Set LMS_BIN or install it at ${installed}`,
  );
}

function requireCliControl(endpoint, operation) {
  requireEndpoint(endpoint);
  if (endpoint.control !== 'cli') {
    throw new Error(
      `Endpoint "${endpoint.id}" uses control "${endpoint.control}" and cannot ${operation} via the LM Studio CLI`,
    );
  }
}

async function runLms(endpoint, args, options = {}) {
  requireCliControl(endpoint, `run "lms ${args[0]}"`);
  const binary = await resolveLms(options);
  try {
    return await execute(binary, args, options);
  } catch (error) {
    const detail = stripAnsi(error.stderr || error.stdout || error.message).trim();
    throw new Error(`LM Studio CLI failed (${args.join(' ')}): ${detail}`, { cause: error });
  }
}

function findSize(modelId, sizes) {
  if (sizes.has(modelId)) return sizes.get(modelId);
  for (const [name, size] of sizes) {
    if (name.endsWith(`/${modelId}`) || modelId.endsWith(`/${name}`)) return size;
  }
  return null;
}

export async function listModels(endpoint, options = {}) {
  const payload = await requestJson(endpoint, '/api/v0/models', { method: 'GET' }, options);
  if (!Array.isArray(payload?.data)) {
    throw new Error(`LM Studio endpoint "${endpoint.id}" returned an invalid model list`);
  }

  let sizes = new Map();
  if (endpoint.control === 'cli') {
    const { stdout } = await runLms(endpoint, ['ls'], options);
    sizes = parseLsOutput(stdout);
  }

  return payload.data.map((model) => ({
    id: model.id,
    type: model.type,
    arch: model.arch ?? null,
    quantization: model.quantization ?? null,
    state: model.state,
    maxContext: model.max_context_length ?? null,
    capabilities: Array.isArray(model.capabilities) ? model.capabilities : [],
    sizeGb: endpoint.control === 'cli' ? findSize(model.id, sizes) : null,
  }));
}

export async function ps(endpoint, options = {}) {
  if (endpoint.control === 'cli') {
    const { stdout } = await runLms(endpoint, ['ps'], options);
    return parsePsOutput(stdout);
  }

  const models = await listModels(endpoint, options);
  return models
    .filter((model) => model.state === 'loaded')
    .map((model) => ({
      identifier: model.id,
      model: model.id,
      status: 'loaded',
      sizeGb: model.sizeGb,
      context: model.maxContext,
      parallel: null,
    }));
}

export async function load(
  endpoint,
  modelId,
  { contextLength, identifier = modelId, gpu = 'max' } = {},
  options = {},
) {
  requireCliControl(endpoint, 'load models');
  const args = ['load', modelId, '--gpu', String(gpu)];
  if (contextLength != null) args.push('--context-length', String(contextLength));
  args.push('--identifier', String(identifier));
  await runLms(endpoint, args, options);
  return { model: modelId, identifier };
}

export async function unload(endpoint, identifier, options = {}) {
  requireCliControl(endpoint, 'unload models');
  await runLms(endpoint, ['unload', identifier], options);
  return { identifier };
}
