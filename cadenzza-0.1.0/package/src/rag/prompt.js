/**
 * Versioned prompt template for grounded Q&A. Bump PROMPT_VERSION on any wording change:
 * it is logged with every answer and compared in evaluation.
 */
import { estimateTokens } from './chunk.js';

export const PROMPT_VERSION = 'qa-v1';
export const NOT_FOUND = 'Not found in the ingested material.';

const SYSTEM = `You answer questions about a team's release, deployment, environment and stakeholder documentation.

Rules:
1. Use ONLY the numbered sources in the user message. Do not use outside knowledge.
2. After every sentence that states a fact, cite the source(s) it comes from as [n], e.g. [2] or [1][3].
3. If the sources do not contain the answer, reply with exactly: "${NOT_FOUND}" and nothing else.
4. Names such as CLIENT_A, PERSON_01, PROJECT_02 or [PERSON_EMAIL] are pseudonyms. Use them exactly as written. Never guess or invent the real names behind them.
5. Be concise: short paragraphs or a short list of steps. Answer in the language of the question.`;

const label = (c) => {
  const where = [c.doc_title, ...(c.heading_path || [])].filter((x, i, a) => x && x !== a[i - 1]).join(' › ');
  const page = c.page_start ? (c.page_end && c.page_end !== c.page_start ? ` (p. ${c.page_start}-${c.page_end})` : ` (p. ${c.page_start})`) : '';
  return `${where}${page}`;
};

/** Keep the best-ranked contexts that fit the token budget (always at least one). */
export function fitContexts(contexts, budgetTokens) {
  const out = [];
  let used = 0;
  for (const c of contexts) {
    const t = estimateTokens(c.text) + 20;
    if (out.length && used + t > budgetTokens) break;
    out.push(c);
    used += t;
  }
  return out;
}

/**
 * @param {string} question   already masked
 * @param {object[]} contexts { text, doc_title, heading_path, page_start, page_end }, best first
 * @returns {{ messages, version }}
 */
export function buildPrompt(question, contexts) {
  const sources = contexts.map((c, i) => `[${i + 1}] ${label(c)}\n${c.text}`).join('\n\n');
  return {
    version: PROMPT_VERSION,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Sources:\n\n${sources}\n\nQuestion: ${question}` }
    ]
  };
}

/** Citation numbers used in an answer, in order of first use, limited to 1..n. */
export function citedNumbers(answer, n) {
  const seen = [];
  for (const m of String(answer).matchAll(/\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\]/g)) {
    for (const part of m[1].split(/\s*,\s*/)) {
      const range = part.split(/\s*[–-]\s*/).map(Number);
      const [a, b = a] = range;
      for (let i = a; i <= Math.min(b, a + 20); i++) if (i >= 1 && i <= n && !seen.includes(i)) seen.push(i);
    }
  }
  return seen;
}

export const isRefusal = (answer) => String(answer).trim().replace(/^"|"$/g, '').startsWith(NOT_FOUND.slice(0, -1));
