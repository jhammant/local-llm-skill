import * as lmstudio from './lmstudio.mjs';
import { admit } from './ration.mjs';

export const JOB_CLASSES = Object.freeze({
  reflex: Object.freeze([
    'google/gemma-3-4b',
    'openai/gpt-oss-20b',
  ]),
  workhorse: Object.freeze([
    'qwen3.6-27b@4bit',
    'qwen/qwen3.6-27b',
  ]),
  coder: Object.freeze([
    'qwen/qwen3-coder-next',
    'qwen/qwen3-next-80b',
  ]),
  heavy: Object.freeze([
    'openai/gpt-oss-120b',
    'minimax-m2.5',
  ]),
  vision: Object.freeze([
    'qwen/qwen3-vl-8b',
    'google/gemma-3-4b',
  ]),
  embed: Object.freeze([
    'text-embedding-nomic-embed-text-v1.5',
  ]),
  security: Object.freeze([
    'qwen3.6-35b-a3b-abliterated-heretic-mlx',
    'qwen3.6-27b-abliterated-heretic-uncensored-mlx',
  ]),
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

function modelMatchesClass(model, jobClass) {
  if (jobClass === 'vision') return model.type === 'vlm';
  if (jobClass === 'embed') return model.type === 'embeddings';
  return model.type === 'llm' || model.type === 'vlm' || model.type == null;
}

export async function selectModel({
  class: requestedClass = 'workhorse',
  endpoint,
  requireTools = false,
  client = lmstudio,
  admitFn = admit,
  admissionOptions = {},
} = {}) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new Error('An endpoint object is required for model selection');
  }
  if (!Object.hasOwn(JOB_CLASSES, requestedClass)) {
    throw new Error(
      `Unknown job class "${requestedClass}". Available classes: ${Object.keys(JOB_CLASSES).join(', ')}`,
    );
  }

  const models = await client.listModels(endpoint);
  const byId = new Map(models.map((model) => [model.id, model]));
  const rejected = [];

  for (const candidateClass of FALLBACKS[requestedClass]) {
    for (const id of JOB_CLASSES[candidateClass]) {
      const model = byId.get(id);
      if (!model || !modelMatchesClass(model, candidateClass)) {
        rejected.push(`${id}: not present`);
        continue;
      }
      if (requireTools && !model.capabilities?.includes('tool_use')) {
        rejected.push(`${id}: tool_use unavailable`);
        continue;
      }
      const plan = await admitFn(endpoint, id, {
        ...admissionOptions,
        client,
        dryRun: true,
      });
      if (!plan.ok) {
        rejected.push(`${id}: ${plan.reason}`);
        continue;
      }

      const fallback = candidateClass === requestedClass
        ? ''
        : ` after falling back from ${requestedClass}`;
      return {
        id: model.id,
        model,
        class: candidateClass,
        requestedClass,
        admission: plan,
        why: `Selected ${model.id} for ${candidateClass}${fallback}; admission action: ${plan.action}`,
      };
    }
  }

  throw new Error(
    `No admissible model found for class "${requestedClass}"${requireTools ? ' with tool_use' : ''}. ${rejected.join('; ')}`,
  );
}
