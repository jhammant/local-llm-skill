// `local-llm models --check-updates` — an OPTIONAL enrichment that asks the
// HuggingFace API which text-generation models are currently popular, keeps
// only the ones that would actually fit this machine's memory budget, and
// flags newer quantisations of models already installed.
//
// Honesty rules baked in here:
//   - The list is ranked by DOWNLOADS. Popularity is not quality, and the
//     output says so (DISCLAIMER below). Nothing here claims a model is
//     "better" — only that it is new, trending, and fits.
//   - A recommendation that cannot load is worse than none, so the memory
//     budget from ration.budget() is a HARD filter. Where a repo publishes
//     several quantisations, the largest one that fits is picked.
//   - The network is optional. Any failure — offline, DNS, HTTP error, rate
//     limiting, timeout — degrades to { ok: false, message } and the CLI
//     prints one line and exits 0. This command never throws for network
//     reasons and never blocks other work.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { budget } from './ration.mjs';
import { resolve } from './providers/index.mjs';

const API_BASE = 'https://huggingface.co/api/models';
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_REPOS = 10;
const FETCH_TIMEOUT_MS = 10_000;
const BYTES_PER_GB = 1024 ** 3;

export const DISCLAIMER = 'new and trending, ranked by downloads — not a quality judgement';

// Quantisation tags as they appear in GGUF filenames (…-Q4_K_M.gguf) and MLX
// repo names (…-4bit). Used both to group a repo's files by quantisation and
// to strip quant tags out of ids when comparing model families.
const QUANT_PATTERN = /(iq[1-4]_[a-z0-9]+|q[2-8](_[a-z0-9]+)*|bf16|fp16|f16|f32|\d+bit)/i;
const QUANT_PATTERN_GLOBAL = /(iq[1-4]_[a-z0-9]+|q[2-8](_[a-z0-9]+)*|bf16|fp16|f16|f32|\d+bit)/gi;

function defaultCachePath() {
  return join(homedir(), '.cache', 'local-llm', 'updates.json');
}

function quantFromString(value) {
  const match = QUANT_PATTERN.exec(String(value ?? ''));
  return match ? match[1].toLowerCase() : null;
}

// Family comparison is deliberately fuzzy: installed ids come from whatever
// the endpoint reports ("qwen2.5-7b-instruct", "lmstudio-community/…-GGUF")
// while HuggingFace ids are "org/name-GGUF". Lowercase basename, minus format
// and quant tokens, minus separators.
function familyKey(id) {
  return String(id ?? '')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(QUANT_PATTERN_GLOBAL, '')
    .replace(/gguf|mlx/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

async function fetchJson(url, fetchFn) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 429) {
    throw new Error('HuggingFace API rate limit hit (HTTP 429); try again later');
  }
  if (!response.ok) {
    throw new Error(`HuggingFace API returned HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

// One trending query per format, merged and de-duplicated by repo id.
async function fetchTrending(fetchFn) {
  const perFormat = await Promise.all(['gguf', 'mlx'].map(async (format) => {
    const url = `${API_BASE}?pipeline_tag=text-generation&filter=${format}`
      + `&sort=downloads&direction=-1&limit=25`;
    const list = await fetchJson(url, fetchFn);
    return (Array.isArray(list) ? list : []).map((entry) => ({
      id: entry.id,
      format,
      downloads: Number(entry.downloads) || 0,
    }));
  }));
  const byId = new Map();
  for (const entry of perFormat.flat()) {
    if (!entry.id) continue;
    const existing = byId.get(entry.id);
    if (!existing || entry.downloads > existing.downloads) byId.set(entry.id, entry);
  }
  return [...byId.values()]
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, MAX_REPOS);
}

// The list endpoint has no file sizes, so each surviving repo needs one
// detail call (?blobs=true) to size its quantisations. A repo whose detail
// call fails is skipped — partial results beat no results.
async function fetchVariants(repo, fetchFn) {
  const detail = await fetchJson(`${API_BASE}/${repo.id}?blobs=true`, fetchFn);
  const siblings = Array.isArray(detail?.siblings) ? detail.siblings : [];
  if (repo.format === 'gguf') {
    const byQuant = new Map();
    for (const file of siblings) {
      if (!/\.gguf$/i.test(file.rfilename ?? '')) continue;
      const quant = quantFromString(file.rfilename) ?? 'unknown';
      byQuant.set(quant, (byQuant.get(quant) ?? 0) + (Number(file.size) || 0));
    }
    return [...byQuant.entries()].map(([quant, bytes]) => ({
      format: 'gguf',
      quant,
      sizeGb: bytes / BYTES_PER_GB,
    }));
  }
  const bytes = siblings
    .filter((file) => /\.safetensors$/i.test(file.rfilename ?? ''))
    .reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  if (bytes <= 0) return [];
  return [{
    format: 'mlx',
    quant: quantFromString(repo.id) ?? 'mlx',
    sizeGb: bytes / BYTES_PER_GB,
  }];
}

async function fetchCandidates(fetchFn) {
  const trending = await fetchTrending(fetchFn);
  const repos = [];
  for (const repo of trending) {
    try {
      const variants = await fetchVariants(repo, fetchFn);
      if (variants.length > 0) repos.push({ ...repo, variants });
    } catch {
      // one repo's detail call failed — skip it, keep the rest
    }
  }
  return repos;
}

async function readCache(cachePath, now) {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    if (
      cached
      && Number.isFinite(cached.fetchedAt)
      && now - cached.fetchedAt < CACHE_TTL_MS
      && Array.isArray(cached.repos)
    ) {
      return cached.repos;
    }
  } catch {
    // missing or unreadable cache is not an error — just refetch
  }
  return null;
}

async function writeCache(cachePath, repos, now) {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ fetchedAt: now, repos }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, cachePath);
  } catch {
    // caching is an optimisation; a failed write must not fail the command
  }
}

function classify(repo, variant, installed) {
  const key = familyKey(repo.id);
  const match = installed.find((model) => familyKey(model.id) === key);
  if (!match) return { status: 'new' };
  const installedQuant = String(match.quantization ?? quantFromString(match.id) ?? '').toLowerCase() || null;
  if (installedQuant != null && installedQuant === variant.quant.toLowerCase()) {
    return null; // already installed at this exact quantisation — nothing to say
  }
  return { status: 'newer-quant', installedId: match.id, installedQuant };
}

// options: fetchFn (tests inject fakes; defaults to global fetch), cachePath,
// now, client (provider fake), plus everything ration.budget() understands.
export async function checkUpdates(endpoint, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const cachePath = options.cachePath ?? defaultCachePath();
  const now = options.now ?? Date.now();
  const provider = options.client ?? resolve(endpoint);

  const report = await budget(endpoint, { ...options, client: provider });
  const budgetGb = report.budgetGb;
  const installed = await provider.listModels(endpoint);

  let repos = await readCache(cachePath, now);
  const cached = repos != null;
  if (!cached) {
    try {
      repos = await fetchCandidates(fetchFn);
    } catch (error) {
      return {
        ok: false,
        message: `Update check skipped: ${error.message}`,
        disclaimer: DISCLAIMER,
        budgetGb,
        updates: [],
      };
    }
    await writeCache(cachePath, repos, now);
  }

  const updates = [];
  for (const repo of repos) {
    // Hard filter first: the largest quantisation that FITS the budget wins;
    // a repo with no fitting quantisation is excluded entirely.
    const fitting = repo.variants
      .filter((variant) => variant.sizeGb <= budgetGb)
      .sort((a, b) => b.sizeGb - a.sizeGb)[0];
    if (!fitting) continue;
    const verdict = classify(repo, fitting, installed);
    if (!verdict) continue;
    updates.push({
      id: repo.id,
      status: verdict.status,
      format: fitting.format,
      quant: fitting.quant,
      sizeGb: fitting.sizeGb,
      downloads: repo.downloads,
      ...(verdict.status === 'newer-quant'
        ? { installedId: verdict.installedId, installedQuant: verdict.installedQuant }
        : {}),
    });
  }
  updates.sort((a, b) => b.downloads - a.downloads);

  return { ok: true, disclaimer: DISCLAIMER, budgetGb, cached, updates };
}
