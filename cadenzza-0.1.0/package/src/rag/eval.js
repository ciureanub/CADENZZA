/**
 * Offline evaluation over golden question sets (JSONL). Deterministic metrics, no LLM judge.
 *
 * Golden item:
 *   { id, question, type: 'answer'|'refuse', expect: [{ doc, section?, page? }], must_contain?: [] }
 *     doc      case-insensitive substring of the (masked) document filename or title
 *     section  case-insensitive substring of the chunk's heading path ("A > B") or its text
 *     page     page/slide number that must fall within the chunk's page range
 *
 * Retrieval  recall@5, recall@10 (a relevant chunk in the top k), MRR@10
 * Answers    refusal accuracy (refuse items refused / answer items not refused), must_contain
 *            coverage, citation accuracy (cited sources that are relevant), groundedness (cited
 *            sentences whose content words appear >= 50% in the cited chunks), uncited rate,
 *            latency p50/p95. Results are written to CADENZZA_HOME/rag/eval/<ts>-<label>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { getSetting } from '../db/index.js';
import { retrieve } from './retrieve.js';
import { ask } from './ask.js';
import { PROMPT_VERSION } from './prompt.js';
import * as mongo from './store/mongo.js';

const STOP = new Set(('a an the and or but of to in on at for by with from as is are was were be been being this that these those it its ' +
  'into than then there their they them which who whom whose what when where why how can could should would may might must will shall ' +
  'also not no yes any all each every some such only very more most other same both either neither our your his her has have had do does did ' +
  'der die das und oder ist sind ein eine einer mit von zu im den dem des auf für nicht si sau este sunt cu de la in pe un o').split(' '));

export function loadGolden(files) {
  const items = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const [i, line] of fs.readFileSync(f, 'utf8').split(/\r?\n/).entries()) {
      const t = line.trim();
      if (!t || t.startsWith('//')) continue;
      try { items.push({ set: path.basename(f), ...JSON.parse(t) }); } catch (err) { throw new Error(`${f}:${i + 1}: ${err.message}`); }
    }
  }
  return items;
}

const lc = (s) => String(s || '').toLowerCase();

/** Does a retrieved chunk satisfy any of the item's expectations? */
export function isRelevant(hit, expect = []) {
  const docName = `${lc(hit.doc?.filename)} ${lc(hit.doc?.title)}`;
  const crumb = lc((hit.chunk?.heading_path || hit.heading_path || []).join(' > '));
  const text = lc(hit.chunk?.text ?? hit.text);
  const ps = hit.chunk?.page_start ?? hit.page_start, pe = hit.chunk?.page_end ?? hit.page_end ?? ps;
  return expect.some((e) => docName.includes(lc(e.doc))
    && (!e.section || crumb.includes(lc(e.section)) || text.includes(lc(e.section)))
    && (e.page == null || (ps != null && e.page >= ps && e.page <= pe)));
}

const words = (s) => (lc(s).match(/[\p{L}\p{N}_+-]{3,}/gu) || []).filter((w) => !STOP.has(w));

/** Share of cited sentences whose content words are mostly present in the chunks they cite. */
export function groundedness(answer, sources) {
  const byN = new Map(sources.map((s) => [s.n, lc(s.text)]));
  let checked = 0, grounded = 0;
  for (const sentence of String(answer).split(/(?<=[.!?])\s+|\n+/)) {
    const cites = [...sentence.matchAll(/\[(\d{1,2})(?:\s*[,–-]\s*(\d{1,2}))*\]/g)].flatMap((m) => m[0].match(/\d{1,2}/g).map(Number));
    if (!cites.length) continue;
    const ws = words(sentence.replace(/\[[\d,\s–-]+\]/g, ''));
    if (ws.length < 3) continue;
    const pool = cites.map((n) => byN.get(n) || '').join(' ');
    checked++;
    if (ws.filter((w) => pool.includes(w)).length / ws.length >= 0.5) grounded++;
  }
  return { checked, grounded };
}

const pct = (v, q) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/**
 * @param {object} o { files, retrievalOnly, mode, label, k, onItem }
 */
export async function runEval(o = {}) {
  const items = loadGolden(o.files);
  if (!items.length) throw new Error(`no golden items found in: ${o.files.join(', ')}`);
  const k = o.k || 10;
  const results = [];
  for (const it of items) {
    const r = { id: it.id, set: it.set, type: it.type || 'answer', question: it.question };
    const ret = await retrieve(it.question, { k, mode: o.mode });
    const ranks = ret.hits.map((h, i) => (isRelevant(h, it.expect) ? i + 1 : 0)).filter(Boolean);
    r.first_relevant_rank = ranks[0] || null;
    if (r.type === 'answer') {
      r.recall5 = ranks.some((x) => x <= 5) ? 1 : 0;
      r.recall10 = ranks.some((x) => x <= 10) ? 1 : 0;
      r.rr = ranks.length ? 1 / ranks[0] : 0;
    }
    r.retrieval_ms = ret.timings.embed_ms + ret.timings.search_ms;

    if (!o.retrievalOnly) {
      const a = await ask(it.question, { mode: o.mode });
      r.answer = a.answer;
      r.refused = a.refused;
      r.refusal_correct = r.type === 'refuse' ? a.refused : !a.refused;
      const cited = a.citations.filter((c) => c.cited);
      r.cited = cited.length;
      r.cited_relevant = cited.filter((c) => isRelevant({ doc: { filename: c.filename, title: c.title }, heading_path: c.heading_path, text: c.text, page_start: c.page_start, page_end: c.page_end }, it.expect)).length;
      r.uncited = a.uncited;
      if (r.type === 'answer' && it.must_contain?.length) {
        const found = it.must_contain.filter((t) => lc(a.answer).includes(lc(t)));
        r.must_found = found.length;
        r.must_total = it.must_contain.length;
      }
      Object.assign(r, { grounded: groundedness(a.answer, a.citations), total_ms: a.timings.total_ms, first_visible_ms: a.timings.first_visible_ms });
    }
    results.push(r);
    o.onItem?.(r);
  }

  const ans = results.filter((r) => r.type === 'answer');
  const ref = results.filter((r) => r.type === 'refuse');
  const docs = await mongo.listDocuments();
  const summary = {
    items: results.length, answerable: ans.length, refuse_items: ref.length,
    recall_at_5: r3(mean(ans.map((r) => r.recall5))),
    recall_at_10: r3(mean(ans.map((r) => r.recall10))),
    mrr_at_10: r3(mean(ans.map((r) => r.rr))),
    retrieval_ms_p50: pct(results.map((r) => r.retrieval_ms), 0.5)
  };
  if (!o.retrievalOnly) {
    const citedTotal = ans.reduce((n, r) => n + r.cited, 0);
    const g = results.reduce((acc, r) => ({ checked: acc.checked + r.grounded.checked, grounded: acc.grounded + r.grounded.grounded }), { checked: 0, grounded: 0 });
    const withMust = ans.filter((r) => r.must_total);
    Object.assign(summary, {
      refusal_accuracy_on_refuse_items: r3(mean(ref.map((r) => (r.refusal_correct ? 1 : 0)))),
      false_refusal_rate: r3(mean(ans.map((r) => (r.refused ? 1 : 0)))),
      must_contain_all: r3(mean(withMust.map((r) => (r.must_found === r.must_total ? 1 : 0)))),
      must_contain_share: r3(mean(withMust.map((r) => r.must_found / r.must_total))),
      citation_accuracy: citedTotal ? r3(ans.reduce((n, r) => n + r.cited_relevant, 0) / citedTotal) : null,
      groundedness: g.checked ? r3(g.grounded / g.checked) : null,
      uncited_rate: r3(mean(ans.filter((r) => !r.refused).map((r) => (r.uncited ? 1 : 0)))),
      total_ms_p50: pct(results.map((r) => r.total_ms), 0.5),
      total_ms_p95: pct(results.map((r) => r.total_ms), 0.95),
      first_visible_ms_p50: pct(results.map((r) => r.first_visible_ms).filter((x) => x != null), 0.5)
    });
  }
  const config = {
    label: o.label || 'eval',
    embed_model: getSetting('rag_embed_model'),
    gen_model: o.retrievalOnly ? null : getSetting('rag_gen_model'),
    gen_num_gpu: o.retrievalOnly ? null : getSetting('rag_gen_num_gpu', 'auto'),
    retrieval: o.mode || getSetting('rag_retrieval', 'hybrid'),
    top_k_answer: Number(getSetting('rag_top_k', '6')),
    prompt_version: PROMPT_VERSION,
    chunker_configs: [...new Set(docs.map((d) => d.chunker_config || 'legacy'))],
    corpus: { documents: docs.length, chunks: docs.reduce((n, d) => n + (d.chunk_count || 0), 0) },
    sets: [...new Set(items.map((i) => i.set))]
  };
  const out = { at: new Date().toISOString(), config, summary, results };
  const dir = path.join(paths.rag, 'eval');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${out.at.replace(/[:.]/g, '-')}-${config.label.replace(/[^\w.-]+/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return { ...out, file };
}
