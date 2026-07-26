// Job classes -> a concrete model, chosen from WHATEVER the endpoint reports.
//
// Deliberately contains no model ids. An earlier version mapped each class to a
// literal list of the author's own models, which meant every lookup missed on
// anyone else's machine and the tool was dead on arrival. Selection is therefore
// capability-based: hard filters (type / tool_use / fits the memory budget),
// then a size preference per class, then weak family hints to break ties.
//
// Users can override any class with ~/.config/local-llm/classes.json:
//   { "workhorse": ["my-preferred-model", "my-fallback"] }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from './providers/index.mjs';
import { admit } from './ration.mjs';

const OVERRIDES = path.join(os.homedir(), '.config', 'local-llm', 'classes.json');

// Weak, pattern-based hints. These only break ties — they are never a hard
// requirement, so a model nobody has ever heard of still gets picked when it is
// the only thing that fits.
const HINTS = Object.freeze({
  coder: /cod(er|e)|dev|program/i,
  vision: /vl|vision|llava|pixtral/i,
  embed: /embed/i,
  reasoning: /think|reason|r1|qwq/i,
  instruct: /instruct|chat|it\b/i,
});

// Models with refusal behaviour removed. Excluded from every ordinary class so
// they are never selected by accident, and reachable ONLY via `security`.
const UNCENSORED = /abliterat|uncensor|heretic|dolphin/i;

// `size` picks how to order admissible candidates:
//   'smallest' — cheapest that can do the job (throughput matters most)
//   'largest'  — most capable that fits; admission handles eviction
//   'balanced' — prefers models under `cap` x budget, and among those the
//                SMALLER one. Right for high-volume classes where a cheaper
//                model run thousands of times beats a better one run slowly.
// Single-shot classes that want the most capable model use 'largest', not
// 'balanced' — on a catalog holding both a 7b and a 32b coder, 'balanced'
// would pick the 7b.
export const JOB_CLASSES = Object.freeze({
  reflex: { type: 'text', size: 'smallest', hint: null },
  workhorse: { type: 'text', size: 'balanced', cap: 0.4, hint: HINTS.instruct },
  coder: { type: 'text', size: 'largest', hint: HINTS.coder, tools: true },
  heavy: { type: 'text', size: 'largest', hint: HINTS.reasoning },
  vision: { type: 'vlm', size: 'balanced', cap: 0.4, hint: HINTS.vision },
  embed: { type: 'embeddings', size: 'smallest', hint: HINTS.embed },
  security: { type: 'text', size: 'balanced', cap: 0.6, hint: null, uncensored: true },
});

const FALLBACKS = Object.freeze({
  reflex: ['reflex'],
  workhorse: ['workhorse', 'reflex'],
  coder: ['coder', 'workhorse', 'reflex'],
  heavy: ['heavy', 'coder', 'workhorse', 'reflex'],
  vision: ['vision'],
  embed: ['embed'],
  security: ['security'],
});

function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  } catch {
    return {};
  }
}

// Hard filter: can this model do this KIND of work at all?
function typeMatches(model, spec) {
  const t = model.type ?? null;
  if (spec.type === 'embeddings') return t === 'embeddings';
  if (spec.type === 'vlm') return t === 'vlm';
  // 'text' accepts llm and vlm (a vision model still does text), never embeddings
  return t !== 'embeddings';
}

// Prefer quantized weights over full precision: on memory-bandwidth-bound
// hardware a 4-8 bit model is markedly faster and rarely worse for these jobs.
function quantScore(model) {
  const q = String(model.quantization ?? '').toLowerCase();
  if (!q || q === 'null') return 0;
  if (/bf16|fp16|f32|^16|^32/.test(q)) return -2;
  if (/3bit|q3|iq1|iq2|1bit|2bit/.test(q)) return -1; // very lossy
  return 1; // 4-8 bit
}

export function scoreCandidates(models, spec, budgetGb) {
  const cap = spec.cap ? budgetGb * spec.cap : Infinity;
  return models
    .map((m) => {
      const size = Number.isFinite(m.sizeGb) ? m.sizeGb : null;
      let score = 0;
      if (spec.hint && spec.hint.test(m.id)) score += 10;
      score += quantScore(m);
      if (spec.size === 'balanced' && size != null && size <= cap) score += 5;
      return { model: m, size, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const as = a.size ?? Infinity;
      const bs = b.size ?? Infinity;
      // within the same score, order by the class's size preference
      if (spec.size === 'largest') return bs - as;
      return as - bs; // 'smallest' and 'balanced' both prefer the smaller of equals
    });
}

export async function selectModel({
  class: requestedClass = 'workhorse',
  endpoint,
  requireTools = false,
  client = null,
  admitFn = admit,
  admissionOptions = {},
  budgetGb = null,
} = {}) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new Error('An endpoint object is required for model selection');
  }
  if (!Object.hasOwn(JOB_CLASSES, requestedClass)) {
    throw new Error(
      `Unknown job class "${requestedClass}". Available classes: ${Object.keys(JOB_CLASSES).join(', ')}`,
    );
  }

  const provider = client ?? resolve(endpoint);
  const models = await provider.listModels(endpoint);
  const overrides = readOverrides();
  const rejected = [];

  // Backends that cannot report sizes (and catalogs where every size is
  // unknown) get no size band and no admission filter — a missing size must
  // never sort as zero, which would make an unknown model look smallest.
  const sizesAvailable = provider.capabilities?.sizes !== false
    && models.some((model) => Number.isFinite(model?.sizeGb));

  // Same principle for tool_use: a backend that cannot report capabilities
  // (toolInfo: false) must not hard-filter on them, and neither may a model
  // whose capabilities are unknown (null, e.g. a failed lookup). Absence of
  // information is not denial — only a KNOWN-empty capability list excludes.
  const toolInfoAvailable = provider.capabilities?.toolInfo !== false;

  for (const candidateClass of FALLBACKS[requestedClass]) {
    const spec = JOB_CLASSES[candidateClass];

    // An explicit user override wins outright, in the order they listed.
    const preferred = Array.isArray(overrides[candidateClass]) ? overrides[candidateClass] : [];
    const byId = new Map(models.map((m) => [m.id, m]));
    const ordered = [
      ...preferred.map((id) => byId.get(id)).filter(Boolean).map((m) => ({ model: m, size: m.sizeGb ?? null })),
      ...scoreCandidates(
        models.filter((m) => {
          if (!typeMatches(m, spec)) return false;
          // uncensored models are opt-in only, and `security` wants only those
          if (spec.uncensored) return UNCENSORED.test(m.id);
          return !UNCENSORED.test(m.id);
        }),
        spec,
        budgetGb ?? Infinity,
      ),
    ];

    for (const { model } of ordered) {
      const needTools = requireTools || spec.tools === true;
      if (needTools && toolInfoAvailable
          && Array.isArray(model.capabilities)
          && !model.capabilities.includes('tool_use')) {
        rejected.push(`${model.id}: no tool_use`);
        continue;
      }
      // Without size information there is no admission filter to apply.
      const plan = sizesAvailable
        ? await admitFn(endpoint, model.id, { ...admissionOptions, client: provider, dryRun: true })
        : { ok: true, action: 'unmanaged', evicted: [], reason: 'backend does not report sizes' };
      if (!plan.ok) {
        rejected.push(`${model.id}: ${plan.reason}`);
        continue;
      }
      const via = candidateClass === requestedClass ? '' : ` (fell back from ${requestedClass})`;
      return {
        id: model.id,
        model,
        class: candidateClass,
        requestedClass,
        admission: plan,
        why:
          `${model.id} chosen for ${candidateClass}${via}: type=${model.type ?? '?'}` +
          `${model.quantization ? ', ' + model.quantization : ''}` +
          `${Number.isFinite(model.sizeGb) ? ', ' + model.sizeGb.toFixed(1) + 'GB' : ''}` +
          `; admission ${plan.action}` +
          `${sizesAvailable ? '' : '; selected without size information'}` +
          `${needTools && !toolInfoAvailable
            ? '; tool support unverified (backend does not report capabilities)'
            : ''}`,
      };
    }
  }

  throw new Error(
    `No admissible model found for class "${requestedClass}"${requireTools ? ' with tool_use' : ''}. ` +
      (rejected.length ? rejected.join('; ') : 'no models reported by the endpoint'),
  );
}
