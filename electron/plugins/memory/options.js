const { readPluginOptions } = require("../registry");
const { storageService } = require("../../storage");
const shortTerm = require("./shortTerm");
const longTerm = require("./longTerm");

const integer = (value, fallback, minimum = 1) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
};

function normalizeOptions(plugin) {
  const short = { ...shortTerm.getDefaults(), ...plugin?.shortTerm };
  const long = { ...longTerm.getDefaults(), ...plugin?.longTerm };
  const work = { enabled: false, extractEveryNObservations: 3, flushAfterMs: 120000,
    batchSize: 16, maxTokens: 1800, maxEvidence: 2000, maxQuestions: 30,
    maxClaims: 20, maxContextChars: 8000, ...plugin?.work };
  work.enabled = work.enabled === true;
  for (const [key, fallback] of Object.entries({ extractEveryNObservations: 3, flushAfterMs: 120000,
    batchSize: 16, maxTokens: 1800, maxEvidence: 2000, maxQuestions: 30, maxClaims: 20, maxContextChars: 8000 })) {
    work[key] = integer(work[key], fallback);
  }
  work.batchSize = Math.min(32, work.batchSize);

  short.enabled = short.enabled !== false;
  short.maxTurns = integer(short.maxTurns, 8);
  short.ttlMs = integer(short.ttlMs, 1_800_000);
  long.enabled = long.enabled !== false;
  long.maxInject = integer(long.maxInject, 5);
  long.extractEveryNTurns = integer(long.extractEveryNTurns, longTerm.getDefaults().extractEveryNTurns);
  long.maxTokens = integer(long.maxTokens, longTerm.getDefaults().maxTokens);
  long.maxEntries = integer(long.maxEntries, 500);

  const practice = { enabled: false, extractEveryNObservations: 3, flushAfterMs: 120000,
    maxTokens: 8192, maxInject: 3, staleAfterMs: 604800000, ...plugin?.practice };
  practice.enabled = practice.enabled === true;
  for (const [key, fallback] of Object.entries({ extractEveryNObservations: 3, flushAfterMs: 120000,
    maxTokens: 8192, maxInject: 3, staleAfterMs: 604800000 })) practice[key] = integer(practice[key], fallback);

  const store = { enabled: long.enabled || work.enabled || practice.enabled, maxEntries: 5000, eventRetentionDays: 30, ...plugin?.store };
  store.enabled = store.enabled !== false;
  store.maxEntries = Math.min(100000, integer(store.maxEntries, 5000));
  store.eventRetentionDays = Math.min(3650, integer(store.eventRetentionDays, 30));
  const maintenance = { batchSize: 16, extractEveryNEvents: 3, flushAfterMs: 60000, pollMs: 15000,
    maxSourceChars: 24000, maxContextChars: 32000, maxTokens: 8192, candidateLimit: 48, ...plugin?.maintenance };
  for (const [key, fallback] of Object.entries({ batchSize: 16, extractEveryNEvents: 3, flushAfterMs: 60000,
    pollMs: 15000, maxSourceChars: 24000, maxContextChars: 32000, maxTokens: 8192, candidateLimit: 48 })) maintenance[key] = integer(maintenance[key], fallback);
  maintenance.batchSize = Math.min(32, maintenance.batchSize);
  maintenance.pollMs = Math.max(1000, maintenance.pollMs);
  maintenance.maxTokens = Math.min(32768, maintenance.maxTokens);
  const retrieval = { maxInject: 8, maxPinned: 6, maxContextChars: 12000, minSimilarity: 0.45, ...plugin?.retrieval };
  for (const [key, fallback] of Object.entries({ maxInject: 8, maxPinned: 6, maxContextChars: 12000 })) retrieval[key] = integer(retrieval[key], fallback);
  retrieval.maxInject = Math.min(32, retrieval.maxInject);
  retrieval.maxPinned = Math.min(16, retrieval.maxPinned);
  const similarity = Number(retrieval.minSimilarity);
  retrieval.minSimilarity = Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0.45;
  const embedding = { enabled: false, endpoint: "", model: "", apiKey: "", proxy: "", timeoutMs: 4000, batchSize: 16, ...plugin?.embedding };
  embedding.enabled = embedding.enabled === true;
  for (const key of ["endpoint", "model", "apiKey", "proxy"]) embedding[key] = typeof embedding[key] === "string" ? embedding[key].trim() : "";
  embedding.timeoutMs = Math.min(30000, integer(embedding.timeoutMs, 4000));
  embedding.batchSize = Math.min(32, integer(embedding.batchSize, 16));
  const questions = { enabled: work.enabled, maxQuestions: 30, ...plugin?.questions };
  questions.enabled = questions.enabled === true;
  questions.maxQuestions = integer(questions.maxQuestions, 30);

  return {
    enabled: Boolean(plugin && plugin.enabled !== false),
    storageService: storageService(plugin?.storageService),
    shortTerm: short,
    longTerm: long,
    work, practice, store, maintenance, retrieval, embedding, questions,
  };
}

function getOptions(config = {}) {
  return readPluginOptions(config, "memory", normalizeOptions);
}

module.exports = { getOptions, normalizeOptions };
