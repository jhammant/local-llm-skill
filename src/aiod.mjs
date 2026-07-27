// Bridge to the optional `aiod` CLI. aiod owns all provider-specific rental
// logic; this module only resolves the executable, parses its output, and
// exposes the resulting OpenAI-compatible endpoint.
//
// Cost safety is structural:
//   - spin() always runs a $0 dry-run proposal before it can launch;
//   - --idle and --ttl are mandatory here, even if an aiod profile has them;
//   - launch authorization is a per-call argument, never config or env state;
//   - a failed launch is torn down before its error is returned.
import { execFile, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { chat as httpChat, embed as httpEmbed } from './providers/http.mjs';

export const AIOD_INSTALL_HINT =
  'aiod not found. Install AIonDemandCluster from github.com/jhammant/AIonDemandCluster or set AIOD_BIN.';

export const AIOD_PROXY_STATUS_URL = 'http://127.0.0.1:4000/aiod/status';

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_RE, '');
}

function execute(file, args, options = {}) {
  const execFileFn = options.execFileFn ?? execFile;
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: options.env ?? process.env,
        ...(options.signal == null ? {} : { signal: options.signal }),
      },
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

function errorDetail(error) {
  return stripAnsi(error?.stderr || error?.stdout || error?.message || error).trim();
}

function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be set to a positive number before a burst instance can be started`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function firstNumber(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseGpuAndQuant(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(.*?)\s+\(([^()]+)\)\s*$/);
  return match
    ? { gpu: match[1].trim(), quant: match[2].trim() }
    : { gpu: text || null, quant: null };
}

// Resolve only from an explicit AIOD_BIN for this process or the current PATH.
// There is deliberately no user-specific or repository-specific fallback.
export async function resolveAiod(options = {}) {
  const env = options.env ?? process.env;
  if (env.AIOD_BIN) {
    if (await isExecutable(env.AIOD_BIN, options)) return env.AIOD_BIN;
    return null;
  }
  try {
    const { stdout } = await execute('which', ['aiod'], options);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found && await isExecutable(found, options)) return found;
  } catch {
    // Not on PATH is a normal, supported state.
  }
  return null;
}

export function parseEstimateOutput(output, quant = null) {
  const clean = stripAnsi(output);
  const rows = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const cells = rawLine
      .split(/[│|]/)
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 4) continue;
    const priceCell = cells.find((cell) => /\$\s*\d/.test(cell));
    const vramCell = cells.find((cell) => /\d+(?:\.\d+)?\s*GB/i.test(cell));
    if (!priceCell || !vramCell) continue;
    const rowQuant = cells[0].replace(/\s.*$/, '').toLowerCase();
    const gpuIndex = cells.indexOf(vramCell) + 1;
    rows.push({
      quant: rowQuant,
      vramGb: firstNumber(vramCell),
      gpu: cells[gpuIndex] ?? null,
      pricePerHour: firstNumber(priceCell),
    });
  }
  const wanted = quant == null ? null : String(quant).toLowerCase();
  const selected = (wanted && rows.find((row) => row.quant === wanted)) ?? rows[0];
  if (!selected || selected.vramGb == null || selected.pricePerHour == null) {
    throw new Error('Could not parse aiod estimate output');
  }
  return selected;
}

export async function estimate(model, { quant = 'fp8', ...options } = {}) {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('A model is required to estimate a burst');
  }
  const binary = options.binary ?? await resolveAiod(options);
  if (!binary) return { available: false, reason: AIOD_INSTALL_HINT };
  const args = ['estimate', model, '--quant', quant];
  if (options.maxPrice != null) args.push('--max-price', String(options.maxPrice));
  let result;
  try {
    result = await execute(binary, args, options);
  } catch (error) {
    throw new Error(`aiod estimate failed: ${errorDetail(error)}`, { cause: error });
  }
  return {
    available: true,
    model,
    ...parseEstimateOutput(`${result.stdout}\n${result.stderr}`, quant),
  };
}

function emptyStatus(available, extra = {}) {
  return {
    available,
    running: false,
    serving: false,
    baseUrl: null,
    apiKey: null,
    model: null,
    gpu: null,
    quant: null,
    pricePerHour: null,
    costSoFar: null,
    ttlRemaining: null,
    idleRemaining: null,
    idleMinutes: null,
    ttlHours: null,
    state: null,
    ...extra,
  };
}

export function parseProxyStatus(payload, { now = Date.now() } = {}) {
  const instance = payload?.instance;
  if (!instance || typeof instance !== 'object') {
    return emptyStatus(true, {
      spinning: Boolean(payload?.spinning),
      state: payload?.spinning ? 'creating' : null,
    });
  }
  const createdAtMs = Number(instance.created_at) * 1_000;
  const ageHours = Number.isFinite(createdAtMs)
    ? Math.max(0, (now - createdAtMs) / 3_600_000)
    : null;
  const pricePerHour = Number.isFinite(Number(instance.price_per_hr))
    ? Number(instance.price_per_hr)
    : null;
  const ttlHours = Number.isFinite(Number(instance.ttl_hours))
    ? Number(instance.ttl_hours)
    : null;
  const idleMinutes = Number.isFinite(Number(payload.idle_minutes ?? instance.idle_minutes))
    ? Number(payload.idle_minutes ?? instance.idle_minutes)
    : null;
  const idleSeconds = Number(payload.idle_seconds);
  const baseUrl = normalizeBaseUrl(
    instance.base_url
      ?? (instance.host && instance.port ? `http://${instance.host}:${instance.port}` : null),
  );
  const apiKey = typeof instance.api_key === 'string' && instance.api_key !== ''
    ? instance.api_key
    : null;
  return {
    available: true,
    running: true, // A tracked instance may be billing while creating/loading.
    serving: instance.status === 'running' && baseUrl != null && apiKey != null,
    spinning: Boolean(payload.spinning),
    baseUrl,
    apiKey,
    model: instance.repo_id ?? null,
    gpu: instance.gpu_desc ?? null,
    quant: instance.quant ?? null,
    pricePerHour,
    costSoFar: ageHours != null && pricePerHour != null ? ageHours * pricePerHour : null,
    ttlRemaining: ageHours != null && ttlHours != null ? ttlHours - ageHours : null,
    idleRemaining:
      idleMinutes != null && Number.isFinite(idleSeconds)
        ? Math.max(0, idleMinutes - idleSeconds / 60)
        : null,
    idleMinutes,
    ttlHours,
    state: instance.status ?? (payload.spinning ? 'creating' : null),
    instanceId: instance.instance_id ?? null,
  };
}

function labelledValue(clean, label) {
  for (const line of clean.split(/\r?\n/)) {
    const cells = line.split('│').map((cell) => cell.trim()).filter(Boolean);
    if (cells[0]?.toLowerCase() === label.toLowerCase()) return cells[1] ?? null;
  }
  const pattern = new RegExp(`${label}\\s+([^\\r\\n│]+)`, 'i');
  return clean.match(pattern)?.[1]?.trim() ?? null;
}

export function parseStatusOutput(output) {
  const clean = stripAnsi(output);
  if (/No instance tracked|Nothing (?:is )?running|No running instance/i.test(clean)) {
    return emptyStatus(true);
  }
  const instanceId = labelledValue(clean, 'Instance');
  const model = labelledValue(clean, 'Model');
  const endpoint = labelledValue(clean, 'Endpoint');
  const price = labelledValue(clean, 'Price');
  const runningFor = labelledValue(clean, 'Running for');
  const ttl = labelledValue(clean, 'TTL');
  const gpuQuant = parseGpuAndQuant(labelledValue(clean, 'GPU'));
  if (!instanceId && !model && !endpoint && !price && !runningFor) {
    return emptyStatus(true, {
      statusUnknown: clean.trim() !== '',
      raw: clean.trim(),
    });
  }
  const costMatch = runningFor?.match(/\(\s*~?\$(\d+(?:\.\d+)?)\s+so far/i);
  const ttlNumber = firstNumber(ttl);
  const baseUrl = normalizeBaseUrl(endpoint);
  return {
    ...emptyStatus(true),
    running: true,
    // The CLI intentionally does not print the bearer token. status() merges
    // the aiod state file below before an endpoint is considered usable.
    serving: false,
    baseUrl,
    model,
    gpu: gpuQuant.gpu,
    quant: gpuQuant.quant,
    pricePerHour: firstNumber(price),
    costSoFar: costMatch ? Number(costMatch[1]) : null,
    ttlRemaining: /exceeded/i.test(ttl ?? '') ? -Math.abs(ttlNumber ?? 0) : ttlNumber,
    state: baseUrl == null ? 'creating' : 'running',
    instanceId,
  };
}

function defaultStatePath(options = {}) {
  if (options.statePath) return options.statePath;
  const env = options.env ?? process.env;
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'aiod', 'state.json');
  }
  if (platform() === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'aiod', 'state.json');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'aiod', 'state.json');
}

async function readTrackedState(options = {}) {
  try {
    return JSON.parse(
      await (options.readFileFn ?? readFile)(defaultStatePath(options), 'utf8'),
    );
  } catch {
    return null;
  }
}

async function proxyStatus(options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  try {
    const response = await fetchFn(options.proxyStatusUrl ?? AIOD_PROXY_STATUS_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(options.proxyTimeoutMs ?? 350),
    });
    if (!response?.ok) return null;
    const payload = typeof response.json === 'function'
      ? await response.json()
      : JSON.parse(await response.text());
    return parseProxyStatus(payload, options);
  } catch {
    return null;
  }
}

export async function status(options = {}) {
  // The proxy is structured and can reveal a live billed instance even if the
  // CLI later becomes unavailable, so it is always the first read-only probe.
  const proxy = await proxyStatus(options);
  if (proxy) return proxy;

  const binary = Object.hasOwn(options, 'binary')
    ? options.binary
    : await resolveAiod(options);
  if (!binary) return emptyStatus(false, { reason: AIOD_INSTALL_HINT });
  try {
    const result = await execute(binary, ['status'], options);
    const parsed = parseStatusOutput(`${result.stdout}\n${result.stderr}`);
    if (!parsed.running) return parsed;
    const tracked = await readTrackedState(options);
    if (!tracked) return parsed;
    const structured = parseProxyStatus({ instance: tracked }, options);
    return {
      ...parsed,
      ...structured,
      // Preserve provider-observed state from the CLI when available.
      state: parsed.state ?? structured.state,
    };
  } catch (error) {
    return emptyStatus(true, {
      statusUnknown: true,
      error: `aiod status failed: ${errorDetail(error)}`,
    });
  }
}

function spinArguments(opts, { dryRun = false } = {}) {
  const args = ['spin'];
  if (opts.model) args.push(opts.model);
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.quant) args.push('--quant', opts.quant);
  if (opts.maxPrice != null) args.push('--max-price', String(opts.maxPrice));
  args.push('--idle', String(opts.idle), '--ttl', String(opts.ttl), '--no-ccr');
  if (dryRun) args.push('--dry-run');
  // aiod's own prompt is bypassed only after local-llm has performed its
  // proposal and per-invocation confirmation gate.
  args.push('--yes');
  return args;
}

export function parseSpinPlan(output, opts = {}) {
  const clean = stripAnsi(output);
  const gpu = clean.match(/GPU:\s*(.+?)(?:\s+·|\r?\n)/i)?.[1]?.trim()
    ?? clean.match(/Would rent offer\b.*?—\s*(.+?)\s+@\s+\$/i)?.[1]?.trim()
    ?? null;
  const pricePerHour = firstNumber(
    clean.match(/Price:\s*\$?\s*(\d+(?:\.\d+)?)\s*\/hr/i)?.[1]
      ?? clean.match(/@\s*\$(\d+(?:\.\d+)?)\s*\/hr/i)?.[1],
  );
  const model = clean.match(/Would rent offer\b[\s\S]*?\n/i)
    ? (opts.model ?? opts.profile ?? null)
    : (opts.model ?? opts.profile ?? null);
  if (!gpu || pricePerHour == null) {
    throw new Error('Could not parse the GPU and live $/hr from the aiod dry-run plan; refusing to spin');
  }
  const estimatedRuntimeMinutes = positiveNumber(
    opts.estimatedRuntimeMinutes ?? Number(opts.ttl) * 60,
    'estimated runtime',
  );
  return {
    model,
    profile: opts.profile ?? null,
    quant: opts.quant ?? null,
    gpu,
    pricePerHour,
    estimatedRuntimeMinutes,
    estimatedTotalCost: pricePerHour * (estimatedRuntimeMinutes / 60),
    idleMinutes: Number(opts.idle),
    ttlHours: Number(opts.ttl),
    maxPricePerHour: opts.maxPrice == null ? null : Number(opts.maxPrice),
  };
}

export function formatSpinPlan(plan) {
  const runtimeMinutes = Number(plan.estimatedRuntimeMinutes);
  const runtime = runtimeMinutes >= 60
    ? `${(runtimeMinutes / 60).toFixed(runtimeMinutes % 60 === 0 ? 0 : 1)}h`
    : `${runtimeMinutes.toFixed(runtimeMinutes < 10 ? 1 : 0)}m`;
  return [
    'BURST LAUNCH PLAN — THIS WILL SPEND REAL MONEY',
    `  Model/profile:      ${plan.model ?? plan.profile ?? '?'}`,
    `  GPU:                ${plan.gpu}`,
    `  Live price:         $${Number(plan.pricePerHour).toFixed(2)}/hr`,
    `  Estimated runtime:  ${runtime} (estimate)`,
    `  Estimated total:    ~$${Number(plan.estimatedTotalCost).toFixed(2)} (estimate)`,
    `  Idle timeout:       ${plan.idleMinutes}m`,
    `  TTL hard backstop:  ${plan.ttlHours}h`,
  ].join('\n');
}

async function proposeSpin(binary, opts, options) {
  let result;
  try {
    result = await execute(binary, spinArguments(opts, { dryRun: true }), options);
  } catch (error) {
    throw new Error(`aiod dry-run failed: ${errorDetail(error)}`, { cause: error });
  }
  return parseSpinPlan(`${result.stdout}\n${result.stderr}`, opts);
}

// A read-only, $0 proposal used by `local-llm plan` and by spin's mandatory
// confirmation gate. It can inspect live offers, but it cannot launch the
// paid subprocess because it has no spawn path.
export async function propose(opts = {}, options = {}) {
  const idle = positiveNumber(opts.idle, '--idle');
  const ttl = positiveNumber(opts.ttl, '--ttl');
  if (!opts.model && !opts.profile) {
    throw new Error('A model or --profile is required to propose a burst instance');
  }
  const binary = options.binary ?? await resolveAiod(options);
  if (!binary) return { available: false, reason: AIOD_INSTALL_HINT };
  const normalized = { ...opts, idle, ttl };
  return {
    available: true,
    plan: await proposeSpin(binary, normalized, options),
  };
}

function runSpawn(file, args, options = {}) {
  const spawnFn = options.spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(file, args, {
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.signal == null ? {} : { signal: options.signal }),
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (child && typeof child.then === 'function') {
      child.then(resolve, reject);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk;
      options.onStdout?.(String(chunk));
    });
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk;
      options.onStderr?.(String(chunk));
    });
    child.once?.('error', reject);
    child.once?.('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(
        `aiod spin exited ${signal ? `on ${signal}` : `with code ${code}`}: ${stripAnsi(stderr || stdout).trim()}`,
      );
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function wait(ms, options) {
  if (options.signal?.aborted) throw abortedError();
  if (options.sleepFn) return options.sleepFn(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortedError());
      }, { once: true });
    }
  });
}

function abortedError() {
  const error = new Error('Burst operation aborted by SIGINT/SIGTERM');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError();
}

async function waitForServing(options) {
  const statusFn = options.statusFn ?? status;
  const timeoutMs = options.readyTimeoutMs ?? 120_000;
  const started = Date.now();
  let latest = null;
  while (Date.now() - started <= timeoutMs) {
    throwIfAborted(options.signal);
    latest = await statusFn(options);
    throwIfAborted(options.signal);
    if (latest?.serving && latest.baseUrl && latest.apiKey) return latest;
    await wait(options.pollIntervalMs ?? 1_000, options);
  }
  throw new Error(
    `aiod spin completed but no serving endpoint appeared within ${Math.round(timeoutMs / 1_000)}s`
      + (latest?.state ? ` (last state: ${latest.state})` : ''),
  );
}

// Launch authorization is accepted only in this function call. There is no
// environment/config fallback and no remembered preference.
export async function spin(opts = {}, options = {}) {
  const idle = positiveNumber(opts.idle, '--idle');
  const ttl = positiveNumber(opts.ttl, '--ttl');
  if (!opts.model && !opts.profile) {
    throw new Error('A model or --profile is required before a burst instance can be started');
  }
  const binary = options.binary ?? await resolveAiod(options);
  if (!binary) return { status: 'unavailable', executed: false, reason: AIOD_INSTALL_HINT };

  const normalized = { ...opts, idle, ttl };
  const proposal = await propose(normalized, { ...options, binary });
  const plan = proposal.plan;
  if (typeof options.onPlan === 'function') {
    await options.onPlan(plan);
  } else {
    (options.output ?? process.stdout).write(`${formatSpinPlan(plan)}\n`);
  }

  let confirmed = options.confirmed === true;
  if (!confirmed && typeof options.confirmFn === 'function') {
    confirmed = await options.confirmFn(plan) === true;
  }
  if (!confirmed) {
    return { status: 'proposed', executed: false, plan };
  }

  let launchStarted = false;
  try {
    launchStarted = true;
    await runSpawn(binary, spinArguments(normalized), options);
    const live = await waitForServing({ ...options, binary });
    return { status: 'running', executed: true, plan, endpoint: live };
  } catch (error) {
    if (launchStarted) {
      try {
        // The launch signal may already be aborted. Cleanup must use a fresh
        // subprocess context or Node will refuse to start the teardown.
        const { signal: _abortedSignal, ...cleanupOptions } = options;
        await teardown({ ...cleanupOptions, binary });
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          `Burst launch failed and teardown also failed. BILLING MAY STILL BE ACTIVE: ${teardownError.message}`,
        );
      }
    }
    throw error;
  }
}

// Idempotent: aiod itself treats an empty tracked-instance slot as success.
export async function teardown(options = {}) {
  const binary = options.binary ?? await resolveAiod(options);
  if (!binary) return { available: false, destroyed: false, reason: AIOD_INSTALL_HINT };
  try {
    const result = await execute(binary, ['teardown', '--yes'], options);
    return {
      available: true,
      destroyed: !/Nothing to tear down/i.test(`${result.stdout}\n${result.stderr}`),
    };
  } catch (error) {
    const detail = errorDetail(error);
    if (/Nothing to tear down|No instance tracked/i.test(detail)) {
      return { available: true, destroyed: false };
    }
    throw new Error(
      `aiod teardown failed; BILLING MAY STILL BE ACTIVE: ${detail}`,
      { cause: error },
    );
  }
}

export async function runWithTeardown(run, options = {}) {
  if (typeof run !== 'function') throw new Error('A burst run function is required');
  const teardownFn = options.teardownFn ?? teardown;
  try {
    return await run();
  } finally {
    const { signal: _abortedSignal, ...cleanupOptions } = options;
    await teardownFn(cleanupOptions);
  }
}

export async function chat(endpoint, request, options = {}) {
  return httpChat(endpoint, request, options);
}

export async function embed(endpoint, request, options = {}) {
  return httpEmbed(endpoint, request, options);
}

export function burstWarning(state) {
  if (!state?.running) return null;
  const cost = Number.isFinite(Number(state.costSoFar))
    ? `$${Number(state.costSoFar).toFixed(2)} spent so far`
    : 'cost so far UNKNOWN';
  const rate = Number.isFinite(Number(state.pricePerHour))
    ? ` at $${Number(state.pricePerHour).toFixed(2)}/hr`
    : '';
  return `!!! BURST INSTANCE LIVE — BILLING${rate}; ${cost} — RUN "local-llm burst down" WHEN DONE !!!`;
}

export async function burstEndpoint(options = {}) {
  const binary = await resolveAiod(options);
  if (!binary) {
    return {
      id: 'burst',
      kind: 'aiod',
      label: 'aiod (vast.ai)',
      control: 'aiod',
      available: false,
      reason: AIOD_INSTALL_HINT,
      baseUrl: null,
      apiKey: null,
    };
  }
  const current = await status({ ...options, binary });
  return {
    id: 'burst',
    kind: 'aiod',
    label: 'aiod (vast.ai)',
    control: 'aiod',
    available: true,
    binary,
    profile: 'qwen3-coder-30b',
    model: current.model,
    quant: current.quant ?? 'fp8',
    maxPricePerHour: 3,
    idleMinutes: null,
    ttlHours: null,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    status: current,
  };
}
