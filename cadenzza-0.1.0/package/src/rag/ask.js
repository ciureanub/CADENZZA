/**
 * ask(question): retrieve -> fit context -> prompt -> assertClean -> local LLM (streamed) -> cited answer.
 *
 * The model only ever sees pseudonymised text. Its output is masked again anyway (a model can
 * still guess a real name from context): streamed tokens pass through a masker that holds back
 * a tail long enough for any protected surface or an e-mail address to complete before release.
 * Each answer is audited with masked fields only.
 */
import * as guard from '../entity/guard.js';
import { audit, getSetting } from '../db/index.js';
import { retrieve } from './retrieve.js';
import { getGenerator } from './generate/index.js';
import { buildPrompt, fitContexts, citedNumbers, isRefusal, PROMPT_VERSION, NOT_FOUND } from './prompt.js';

const EMAIL_HOLD = 40; // typical e-mail length; plus the longest protected surface

/**
 * Wraps a token sink so only masked, stable text is emitted.
 * push(delta) per token; end() flushes and returns { text, replaced } where replaced means the
 * final masked text no longer starts with what was already emitted (the caller must replace it).
 */
export function maskingStream(emit) {
  const hold = guard.maxSurfaceLength() + EMAIL_HOLD;
  let raw = '', sent = '';
  return {
    push(delta) {
      raw += delta;
      const masked = guard.mask(raw);
      const safe = masked.length - hold;
      if (safe > sent.length) {
        const cut = masked.lastIndexOf(' ', safe);
        if (cut > sent.length && masked.startsWith(sent)) { emit(masked.slice(sent.length, cut)); sent = masked.slice(0, cut); }
      }
    },
    end() {
      const masked = guard.mask(raw);
      const replaced = !masked.startsWith(sent);
      if (!replaced && masked.length > sent.length) emit(masked.slice(sent.length));
      return { text: masked, raw, replaced };
    }
  };
}

/**
 * @param {string} question
 * @param {object} o { k, filter, mode, onRetrieval(sources), onToken(delta), onReplace(text), signal }
 */
export async function ask(question, o = {}) {
  const t0 = performance.now();
  if (!String(question || '').trim()) throw new Error('question is required');

  const r = await retrieve(question, o);
  const budget = Number(getSetting('rag_context_tokens', '1200'));
  const contexts = fitContexts(r.hits.map((h) => ({
    ...h.chunk, doc_title: h.doc.title, doc: h.doc, score: h.score, dense_score: h.dense_score, dense_rank: h.dense_rank, lexical_rank: h.lexical_rank
  })), budget);

  const sources = contexts.map((c, i) => ({
    n: i + 1,
    chunk_id: c._id,
    doc_id: c.doc_id,
    title: c.doc.title,
    filename: c.doc.filename,
    file_type: c.doc.file_type,
    page_id: c.doc.page_id,
    heading_path: c.heading_path,
    page_start: c.page_start,
    page_end: c.page_end,
    score: c.score,
    dense_score: c.dense_score,
    dense_rank: c.dense_rank,
    lexical_rank: c.lexical_rank,
    text: c.text
  }));
  o.onRetrieval?.(sources);

  const generator = getGenerator();
  let answer, stats = {}, replaced = false, remasked = false, firstVisibleMs = null;
  const userToken = o.onToken;
  o = { ...o, onToken: (d) => { if (firstVisibleMs == null) firstVisibleMs = performance.now() - t0; userToken?.(d); } };
  const tg = performance.now();
  if (!contexts.length) {
    answer = NOT_FOUND; // nothing ingested matches: no need to ask the model
    o.onToken?.(answer);
  } else {
    const { messages } = buildPrompt(r.question_masked, contexts);
    guard.assertClean(messages, 'ask prompt');
    const stream = maskingStream((d) => o.onToken?.(d));
    const out = await generator.chat(messages, { onToken: (d) => stream.push(d), signal: o.signal });
    const fin = stream.end();
    answer = fin.text.trim();
    remasked = fin.raw !== fin.text;
    replaced = fin.replaced;
    if (replaced) o.onReplace?.(answer);
    stats = out.stats;
  }
  const generate_ms = Math.round(performance.now() - tg);

  const refused = isRefusal(answer);
  const cited = refused ? [] : citedNumbers(answer, sources.length);
  for (const s of sources) s.cited = cited.includes(s.n);

  const result = {
    question_masked: r.question_masked,
    answer,
    refused,
    uncited: !refused && cited.length === 0,
    citations: sources,
    prompt_version: PROMPT_VERSION,
    gen_model: generator.id,
    embed_model: r.embed_model,
    retrieval_mode: r.mode,
    retrieval_fallback: r.fallback,
    timings: {
      ...r.timings,
      generate_ms,
      first_token_ms: stats.first_token_ms != null ? Math.round(stats.first_token_ms) : null, // model, from request
      first_visible_ms: firstVisibleMs != null ? Math.round(firstVisibleMs) : null,          // user, from question
      load_ms: Math.round(stats.load_ms || 0),
      prompt_ms: Math.round(stats.prompt_ms || 0),
      total_ms: Math.round(performance.now() - t0)
    },
    tokens: { prompt: stats.prompt_tokens ?? null, output: stats.output_tokens ?? null }
  };

  audit('rag.ask', JSON.stringify({
    question_masked: result.question_masked,
    retrieved: sources.map((s) => [s.chunk_id, Number(s.score?.toFixed?.(4) ?? s.score)]),
    prompt_version: PROMPT_VERSION,
    gen_model: generator.id,
    embed_model: r.embed_model,
    mode: r.mode,
    refused,
    cited,
    remasked_output: remasked,
    latency_ms: result.timings.total_ms,
    tokens: result.tokens
  }));
  return result;
}
