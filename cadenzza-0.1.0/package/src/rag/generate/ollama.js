/**
 * Ollama generator over plain fetch (/api/chat, NDJSON streaming).
 * Generator: { id, chat(messages, { onToken, signal, options }) -> { text, stats } }
 * think:false always: thinking models otherwise spend the whole budget reasoning and return "".
 * A runner crash before the first token is retried once (seen with large models on the iGPU).
 */
import { RAG } from '../../config.js';

const RUNNER_CRASH = /error was encountered while running the model|forcibly closed|connection reset|EOF/i;

export function ollamaGenerator(id, { numGpu = 'auto', numCtx = 4096, temperature = 0.1, maxTokens = 400 } = {}) {
  const options = { temperature, num_ctx: numCtx, num_predict: maxTokens };
  if (numGpu !== 'auto' && numGpu !== '' && numGpu != null) options.num_gpu = Number(numGpu);

  async function once(messages, { onToken, signal, keepAlive }) {
    const t0 = performance.now(); // before the request: Ollama sends headers only once tokens flow
    const res = await fetch(`${RAG.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: id, messages, stream: true, think: false, keep_alive: keepAlive, options }),
      signal
    });
    if (!res.ok) throw new Error(`ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 200)}`);

    let text = '', firstTokenMs = null, final = null, buf = '';
    const decoder = new TextDecoder();
    for await (const part of res.body) {
      buf += decoder.decode(part, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw Object.assign(new Error(msg.error), { tokens: text.length });
        const delta = msg.message?.content || '';
        if (delta) {
          if (firstTokenMs == null) firstTokenMs = performance.now() - t0;
          text += delta;
          onToken?.(delta);
        }
        if (msg.done) final = msg;
      }
    }
    const ns = (v) => (v || 0) / 1e6;
    return {
      text,
      stats: {
        first_token_ms: firstTokenMs,
        load_ms: ns(final?.load_duration),
        prompt_tokens: final?.prompt_eval_count ?? null,
        prompt_ms: ns(final?.prompt_eval_duration),
        output_tokens: final?.eval_count ?? null,
        output_ms: ns(final?.eval_duration),
        done_reason: final?.done_reason ?? null
      }
    };
  }

  return {
    id,
    async chat(messages, { onToken, signal, keepAlive = '10m' } = {}) {
      let emitted = false;
      const tracked = (d) => { emitted = true; onToken?.(d); };
      try {
        return await once(messages, { onToken: tracked, signal, keepAlive });
      } catch (err) {
        if (emitted || signal?.aborted || !RUNNER_CRASH.test(err.message)) throw err;
        return once(messages, { onToken, signal, keepAlive });
      }
    }
  };
}
