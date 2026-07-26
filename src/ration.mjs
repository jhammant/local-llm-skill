import { execFile } from 'node:child_process';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { resolve } from './providers/index.mjs';

// The client is normally the provider resolved from the endpoint; tests
// inject fakes. A provider that cannot report sizes AND loaded state cannot
// be memory-managed — budget() then reports managed:false and admit() steps
// aside instead of inventing numbers.
function providerFor(endpoint, client) {
  return client ?? resolve(endpoint);
}

function isManaged(provider) {
  const caps = provider?.capabilities ?? {};
  return caps.sizes !== false && caps.loadedState !== false;
}

// pin/unpin on an unmanaged endpoint must fail clearly, not silently record
// a pin that can never influence an eviction decision.
function requireManaged(endpoint, options, operation) {
  if (!isManaged(providerFor(endpoint, options.client))) {
    throw new Error(
      `Endpoint "${endpoint.id}" does not report model sizes or loaded state; ${operation} has no effect there`,
    );
  }
}

const BYTES_PER_GB = 1024 ** 3;
const DEFAULT_RESERVE_GB = 12;
let stateWriteQueue = Promise.resolve();

function paths(options = {}) {
  const configDir = join(homedir(), '.config', 'local-llm');
  return {
    config: options.configPath ?? join(configDir, 'config.json'),
    pins: options.pinsPath ?? join(configDir, 'pins.json'),
    lru: options.lruPath ?? join(homedir(), '.local', 'state', 'local-llm', 'lru.json'),
  };
}

async function readJson(path, fallback, description) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse ${description} ${path}: ${error.message}`, { cause: error });
    }
    throw new Error(`Could not read ${description} ${path}: ${error.message}`, { cause: error });
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function serializeStateWrite(operation) {
  const pending = stateWriteQueue.then(operation, operation);
  stateWriteQueue = pending.catch(() => {});
  return pending;
}

function parseNonNegativeNumber(value, description) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${description} must be a non-negative number; received "${value}"`);
  }
  return number;
}

function executeSysctl(options = {}) {
  if (options.wiredLimitMb != null) return Promise.resolve(Number(options.wiredLimitMb));
  if (options.sysctlFn) return Promise.resolve(options.sysctlFn());
  const execFileFn = options.execFileFn ?? execFile;
  return new Promise((resolve, reject) => {
    execFileFn(
      'sysctl',
      ['-n', 'iogpu.wired_limit_mb'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout = '', stderr = '') => {
        if (error) {
          reject(new Error(
            `Could not read macOS GPU wired-memory limit: ${(stderr || error.message).trim()}`,
            { cause: error },
          ));
          return;
        }
        const value = Number(stdout.trim());
        if (!Number.isFinite(value) || value < 0) {
          reject(new Error(`macOS GPU wired-memory limit was not numeric: "${stdout.trim()}"`));
          return;
        }
        resolve(value);
      },
    );
  });
}

// NVIDIA hosts have dedicated VRAM rather than a unified-memory wired limit, so
// the ceiling comes from the card, not from system RAM.
function executeNvidiaSmi(options = {}) {
  if (options.nvidiaSmiFn) return Promise.resolve(options.nvidiaSmiFn());
  const execFileFn = options.execFileFn ?? execFile;
  return new Promise((resolve) => {
    execFileFn(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout = '') => {
        if (error) return resolve(null);
        // sum across cards; values are MiB
        const total = String(stdout)
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
          .reduce((a, b) => a + b, 0);
        resolve(total > 0 ? total : null);
      },
    );
  });
}

// The memory ceiling is platform-specific. Resolve it explicitly and report
// which source won, so a user on an unsupported host can see why the number is
// what it is rather than being silently given a guess.
export async function resolveCeiling(options = {}, totalGb = 0) {
  const env = options.env ?? process.env;
  if (options.ceilingGb != null) {
    return { ceilingGb: parseNonNegativeNumber(options.ceilingGb, 'ceilingGb'), source: 'option' };
  }
  if (env.LOCAL_LLM_CEILING_GB) {
    return {
      ceilingGb: parseNonNegativeNumber(env.LOCAL_LLM_CEILING_GB, 'LOCAL_LLM_CEILING_GB'),
      source: 'LOCAL_LLM_CEILING_GB',
    };
  }
  const { config } = paths(options);
  const configured = await readJson(config, {}, 'local-llm config');
  if (configured.ceilingGb != null) {
    return { ceilingGb: parseNonNegativeNumber(configured.ceilingGb, 'config ceilingGb'), source: 'config' };
  }

  // explicit test hooks keep the macOS path addressable on any host
  const platform = options.platform ?? process.platform;
  if (options.wiredLimitMb != null || options.sysctlFn || platform === 'darwin') {
    const mb = await executeSysctl(options);
    // 0 means "unset" — macOS then allows roughly 75% of unified memory
    return mb === 0
      ? { ceilingGb: totalGb * 0.75, source: 'macOS default (75% of unified memory)' }
      : { ceilingGb: mb / 1024, source: 'macOS iogpu.wired_limit_mb' };
  }

  if (platform === 'linux' || platform === 'win32') {
    const mb = await executeNvidiaSmi(options);
    if (mb != null) return { ceilingGb: mb / 1024, source: 'nvidia-smi total VRAM' };
  }

  return { ceilingGb: totalGb * 0.6, source: 'fallback estimate (60% of system RAM) — set ceilingGb to override' };
}

async function reserveGb(options = {}) {
  const env = options.env ?? process.env;
  if (env.LOCAL_LLM_RESERVE_GB != null && env.LOCAL_LLM_RESERVE_GB !== '') {
    return parseNonNegativeNumber(
      env.LOCAL_LLM_RESERVE_GB,
      'LOCAL_LLM_RESERVE_GB',
    );
  }

  const { config } = paths(options);
  const configured = await readJson(config, {}, 'local-llm config');
  if (configured.reserveGb != null) {
    return parseNonNegativeNumber(configured.reserveGb, `${config} reserveGb`);
  }
  return DEFAULT_RESERVE_GB;
}

function requireEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.id !== 'string') {
    throw new Error('An endpoint object is required');
  }
}

export async function budget(endpoint, options = {}) {
  requireEndpoint(endpoint);
  const client = providerFor(endpoint, options.client);
  const totalBytes = options.totalMemBytes ?? (options.totalmemFn ?? totalmem)();
  const totalGb = totalBytes / BYTES_PER_GB;
  const { ceilingGb, source: ceilingSource } = await resolveCeiling(options, totalGb);
  const reserve = await reserveGb(options);
  const budgetGb = ceilingGb - reserve;

  // Unmanaged backends cannot report what is resident, so used/free are
  // honestly null — never a guess. totalGb/ceilingGb still describe the host.
  if (!isManaged(client)) {
    return {
      managed: false,
      totalGb,
      ceilingGb,
      ceilingSource,
      reserveGb: reserve,
      budgetGb,
      usedGb: null,
      freeGb: null,
      loaded: [],
    };
  }

  const loaded = options.loaded ?? await client.ps(endpoint);
  const usedGb = loaded.reduce((sum, model) => {
    const size = Number(model.sizeGb);
    return sum + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);

  return {
    managed: true,
    totalGb,
    ceilingGb,
    ceilingSource,
    reserveGb: reserve,
    budgetGb,
    usedGb,
    freeGb: budgetGb - usedGb,
    loaded,
  };
}

export async function readLru(endpoint, options = {}) {
  requireEndpoint(endpoint);
  const { lru } = paths(options);
  const value = await readJson(lru, {}, 'LRU state');
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`LRU state ${lru} must be an object`);
  }
  return value;
}

export async function touch(endpoint, identifier, options = {}) {
  requireEndpoint(endpoint);
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new Error('A model identifier is required to update LRU state');
  }
  if (options.dryRun) return;
  const { lru } = paths(options);
  const now = options.now ?? Date.now();
  await serializeStateWrite(async () => {
    const value = await readJson(lru, {}, 'LRU state');
    value[identifier] = now;
    await writeJsonAtomic(lru, value);
  });
}

export async function listPins(endpoint, options = {}) {
  requireEndpoint(endpoint);
  const { pins } = paths(options);
  const value = await readJson(pins, [], 'pin list');
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Pin list ${pins} must be a JSON list of model ids`);
  }
  return [...new Set(value)];
}

export async function pinModel(endpoint, modelId, options = {}) {
  requireEndpoint(endpoint);
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('A model id is required');
  }
  requireManaged(endpoint, options, 'pinning');
  if (options.dryRun) return listPins(endpoint, options);
  const { pins } = paths(options);
  return serializeStateWrite(async () => {
    const current = await readJson(pins, [], 'pin list');
    if (!Array.isArray(current) || current.some((item) => typeof item !== 'string')) {
      throw new Error(`Pin list ${pins} must be a JSON list of model ids`);
    }
    const next = [...new Set([...current, modelId])];
    await writeJsonAtomic(pins, next);
    return next;
  });
}

export async function unpinModel(endpoint, modelId, options = {}) {
  requireEndpoint(endpoint);
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('A model id is required');
  }
  requireManaged(endpoint, options, 'unpinning');
  if (options.dryRun) return listPins(endpoint, options);
  const { pins } = paths(options);
  return serializeStateWrite(async () => {
    const current = await readJson(pins, [], 'pin list');
    if (!Array.isArray(current) || current.some((item) => typeof item !== 'string')) {
      throw new Error(`Pin list ${pins} must be a JSON list of model ids`);
    }
    const next = current.filter((item) => item !== modelId);
    await writeJsonAtomic(pins, next);
    return next;
  });
}

async function forgetLru(endpoint, identifiers, options = {}) {
  if (identifiers.length === 0) return;
  const { lru } = paths(options);
  await serializeStateWrite(async () => {
    const current = await readJson(lru, {}, 'LRU state');
    for (const identifier of identifiers) delete current[identifier];
    await writeJsonAtomic(lru, current);
  });
}

function loadedMatches(entry, modelId) {
  return entry.model === modelId || entry.identifier === modelId;
}

function modelLoadOptions(model) {
  return {
    identifier: model.id,
    ...(model.maxContext == null ? {} : { contextLength: model.maxContext }),
  };
}

function plannedResult({ action, evicted = [], reason }) {
  return { ok: true, action, evicted, reason };
}

export async function admit(
  endpoint,
  modelId,
  {
    pin = false,
    dryRun = false,
    client = null,
    ...options
  } = {},
) {
  requireEndpoint(endpoint);
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('A model id is required for admission');
  }

  const provider = providerFor(endpoint, client);

  // Admission control is impossible without sizes and loaded state. Step
  // aside — never throw, never block the run, never invent a number, and
  // never pretend anything was evicted.
  if (!isManaged(provider)) {
    return {
      ok: true,
      action: 'unmanaged',
      evicted: [],
      reason: 'backend does not report sizes',
    };
  }

  const report = await budget(endpoint, { ...options, client: provider });
  const alreadyLoaded = report.loaded.find((entry) => loadedMatches(entry, modelId));
  if (alreadyLoaded) {
    if (pin && !dryRun) await pinModel(endpoint, modelId, options);
    return plannedResult({
      action: 'already-loaded',
      reason: `Model "${modelId}" is already loaded`,
    });
  }

  const models = options.models ?? await provider.listModels(endpoint);
  const model = models.find((candidate) => candidate.id === modelId);
  const modelSizeGb = Number(model?.sizeGb);
  if (!model || !Number.isFinite(modelSizeGb) || modelSizeGb <= 0) {
    return {
      ok: false,
      action: 'reject',
      evicted: [],
      reason: 'unknown size',
    };
  }

  if (modelSizeGb > report.budgetGb) {
    const requiredMb = Math.ceil((modelSizeGb + report.reserveGb) * 1024);
    return {
      ok: false,
      action: 'too-big',
      evicted: [],
      reason: `Model "${modelId}" is ${modelSizeGb.toFixed(2)} GB but the inference budget is ${report.budgetGb.toFixed(2)} GB. Increase the wired limit with: sudo sysctl iogpu.wired_limit_mb=${requiredMb}`,
    };
  }

  if (endpoint.control === 'none') {
    return {
      ok: false,
      action: 'unavailable',
      evicted: [],
      reason: `Endpoint "${endpoint.id}" cannot load model "${modelId}"`,
    };
  }

  if (modelSizeGb <= report.freeGb) {
    const action = endpoint.control === 'jit' ? 'jit-load' : 'load';
    if (!dryRun && endpoint.control === 'cli') {
      await provider.load(endpoint, modelId, modelLoadOptions(model));
    }
    if (pin && !dryRun) await pinModel(endpoint, modelId, options);
    return plannedResult({
      action,
      reason: `Model "${modelId}" fits in ${report.freeGb.toFixed(2)} GB of free budget`,
    });
  }

  if (endpoint.control !== 'cli') {
    return {
      ok: false,
      action: 'insufficient-memory',
      evicted: [],
      reason: `Model "${modelId}" needs ${modelSizeGb.toFixed(2)} GB, only ${report.freeGb.toFixed(2)} GB is free, and endpoint "${endpoint.id}" cannot evict models`,
    };
  }

  const [pins, lru] = await Promise.all([
    listPins(endpoint, options),
    readLru(endpoint, options),
  ]);
  const pinned = new Set(pins);
  const candidates = report.loaded
    .filter((entry) => !pinned.has(entry.model))
    .filter((entry) => !loadedMatches(entry, modelId))
    .sort((left, right) => {
      const age = Number(lru[left.identifier] ?? 0) - Number(lru[right.identifier] ?? 0);
      return age || left.identifier.localeCompare(right.identifier);
    });

  let availableGb = report.freeGb;
  const evicted = [];
  for (const candidate of candidates) {
    evicted.push(candidate.identifier);
    const candidateSize = Number(candidate.sizeGb);
    if (Number.isFinite(candidateSize) && candidateSize > 0) availableGb += candidateSize;
    if (modelSizeGb <= availableGb) break;
  }

  if (modelSizeGb > availableGb) {
    return {
      ok: false,
      action: 'insufficient-memory',
      evicted: [],
      reason: `Model "${modelId}" needs ${modelSizeGb.toFixed(2)} GB, but pinned models leave only ${availableGb.toFixed(2)} GB available after all safe evictions`,
    };
  }

  if (!dryRun) {
    const completedEvictions = [];
    try {
      for (const identifier of evicted) {
        await provider.unload(endpoint, identifier);
        completedEvictions.push(identifier);
      }
    } finally {
      await forgetLru(endpoint, completedEvictions, options);
    }
    await provider.load(endpoint, modelId, modelLoadOptions(model));
    if (pin) await pinModel(endpoint, modelId, options);
  }

  return plannedResult({
    action: 'evict-and-load',
    evicted,
    reason: `Evict ${evicted.join(', ')} to make room for "${modelId}"`,
  });
}
