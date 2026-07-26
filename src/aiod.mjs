// STUB — the aiod "burst" bridge (see SPEC-burst.md).
//
// aiod (github.com/jhammant/AIonDemandCluster) is a separate, optional tool
// that rents a GPU and serves an OpenAI-compatible endpoint. This module only
// detects whether the `aiod` binary exists and reports the burst endpoint as
// unavailable when it does not. It deliberately implements NO provisioning:
// nothing here can spin, rent, or otherwise start a paid cloud instance. That
// arrives — behind explicit per-invocation confirmation, idle/ttl backstops,
// and guaranteed teardown — with the real phase-2 build.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export const AIOD_INSTALL_HINT =
  'aiod not found. Install AIonDemandCluster (github.com/jhammant/AIonDemandCluster) or set AIOD_BIN to enable the burst endpoint.';

function execute(file, args, options = {}) {
  const execFileFn = options.execFileFn ?? execFile;
  return new Promise((resolve, reject) => {
    execFileFn(file, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout = '') => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
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

// Resolve the aiod binary from AIOD_BIN or PATH. Never a hardcoded local path.
// Returns null when aiod is simply not installed — absence is normal, not an
// error. Throws only when AIOD_BIN is set but points at something unusable.
export async function resolveAiod(options = {}) {
  const env = options.env ?? process.env;
  if (env.AIOD_BIN) {
    if (await isExecutable(env.AIOD_BIN, options)) return env.AIOD_BIN;
    throw new Error(`AIOD_BIN points to a missing or non-executable file: ${env.AIOD_BIN}`);
  }
  try {
    const { stdout } = await execute('which', ['aiod'], options);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found && await isExecutable(found, options)) return found;
  } catch {
    // Not on PATH — the burst endpoint is unavailable, and that is fine.
  }
  return null;
}

// The burst endpoint descriptor. When aiod is absent the endpoint reports
// itself unavailable; callers must show the local row only and never attempt
// to use it. `available: true` means the binary exists — it still does NOT
// mean anything is running or provisionable from this build.
export async function burstEndpoint(options = {}) {
  const binary = await resolveAiod(options);
  if (!binary) {
    return {
      id: 'burst',
      label: 'aiod (vast.ai)',
      control: 'aiod',
      available: false,
      reason: AIOD_INSTALL_HINT,
      baseUrl: null,
      apiKey: null,
    };
  }
  return {
    id: 'burst',
    label: 'aiod (vast.ai)',
    control: 'aiod',
    available: true,
    binary,
    baseUrl: null,
    apiKey: null,
  };
}
