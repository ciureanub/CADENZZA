import Fastify from 'fastify';
import fstatic from '@fastify/static';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, audit } from '../db/index.js';
import * as pages from '../pages.js';
import * as guard from '../entity/guard.js';
import { search } from '../search/index.js';
import { paths } from '../config.js';
import { importDocument } from './importer.js';
import * as rag from '../rag/ingest.js';
import * as mongoStore from '../rag/store/mongo.js';
import { ask as askQuestion } from '../rag/ask.js';
import { registerRagRoutes } from './rag-routes.js';

/** Registry changed: re-mask ingested RAG documents in the background (only once RAG is in use). */
function scheduleRemask() {
  if (getSetting('rag_ingested', '0') !== '1') return;
  rag.queue.push(() => rag.remaskAfterRegistryChange()).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

const VALID_SETTINGS = {
  storage_mode:    { enum: ['store-and-mask'] },
  pseudonym_style: { enum: ['coded', 'plausible'] },
  chat_mode:       { enum: ['private', 'public'] },
  offline:         { enum: ['1', '0'] },
  rag_embed_model: { readOnly: true, hint: 'switch embedding models with: cadenzza rag reembed --model <id>, then cadenzza rag activate' },
  rag_gen_model:   { re: /^[a-z0-9][\w.\-/]*(?::[\w.\-]+)?$/i },
  rag_top_k:       { re: /^(?:[1-9]|1\d|20)$/ },
  rag_gen_num_gpu: { re: /^(?:auto|\d{1,3})$/ },
  rag_retrieval:   { enum: ['hybrid', 'dense', 'exact'] },
  rag_context_tokens: { re: /^(?:[4-9]\d{2}|[1-3]\d{3}|4000)$/ },
  rag_chunk_tokens: { re: /^(?:1[5-9]\d|[2-9]\d{2}|1000)$/ },
  rag_chunk_merge_min: { re: /^(?:0|[1-9]\d|[12]\d{2}|300)$/ },
  rag_embed_restricted: { enum: ['0', '1'] },
  rag_create_page: { enum: ['0', '1'] },
  registry_version: { readOnly: true }
};

function validatePagePatch(patch) {
  if (patch.sensitivity !== undefined &&
      !['Public', 'Internal', 'Client-Confidential', 'Restricted'].includes(patch.sensitivity))
    throw new Error(`Invalid sensitivity: ${patch.sensitivity}`);
  if (patch.status !== undefined &&
      !['draft', 'review', 'approved', 'archived'].includes(patch.status))
    throw new Error(`Invalid status: ${patch.status}`);
  if (patch.type !== undefined &&
      !['note', 'deliverable', 'template', 'source-capture'].includes(patch.type))
    throw new Error(`Invalid type: ${patch.type}`);
}

/**
 * Resolve a client-supplied path against CADENZZA_HOME/import. Returns null if it
 * escapes the root (traversal, absolute path elsewhere, symlink/junction out).
 */
function resolveImportPath(p) {
  const root = fs.realpathSync(paths.importRoot);
  let target = path.resolve(root, p);
  if (fs.existsSync(target)) target = fs.realpathSync(target);
  const rel = path.relative(root, target);
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;
  return target;
}

/* clamp search query length */
const MAX_Q = 400;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, '..', '..', 'web');

export async function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });
  await app.register(fstatic, { root: WEB, prefix: '/' });

  /* ---- global error handler — always return JSON ---- */
  app.addHook('onClose', async () => { await mongoStore.close(); });

  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode || 500;
    reply.code(status).send({ error: err.message || 'Internal server error' });
  });

  /* ---------- meta ---------- */
  app.get('/api/meta', async () => ({
    spaces: pages.spaces(),
    settings: {
      storage_mode:    getSetting('storage_mode'),
      pseudonym_style: getSetting('pseudonym_style'),
      chat_mode:       getSetting('chat_mode'),
      offline:         getSetting('offline'),
      rag_embed_model: getSetting('rag_embed_model'),
      rag_gen_model:   getSetting('rag_gen_model'),
      rag_gen_num_gpu: getSetting('rag_gen_num_gpu', 'auto'),
      rag_retrieval:   getSetting('rag_retrieval', 'hybrid'),
      rag_top_k:       getSetting('rag_top_k', '6'),
      rag_embed_restricted: getSetting('rag_embed_restricted', '0'),
      rag_create_page: getSetting('rag_create_page', '1')
    },
    counts: {
      pages:      db().prepare('SELECT COUNT(*) c FROM page').get().c,
      entities:   db().prepare('SELECT COUNT(*) c FROM protected_entity WHERE active=1').get().c,
      candidates: db().prepare("SELECT COUNT(*) c FROM entity_occurrence WHERE status='candidate'").get().c
    },
    home: paths.home
  }));

  app.post('/api/settings', async (req, reply) => {
    if (!req.body) return { ok: true };
    for (const [k, v] of Object.entries(req.body)) {
      const validator = VALID_SETTINGS[k];
      if (!validator) {
        audit('settings.unknown', `key=${k}`);
        // accept unknown keys but log them — allows users to extend
      } else {
        if (typeof v !== 'string')
          return reply.code(400).send({ error: `Setting ${k} must be a string` });
        if (validator.enum && !validator.enum.includes(v))
          return reply.code(400).send({ error: `Setting ${k} must be one of: ${validator.enum.join(', ')}` });
        if (validator.re && !validator.re.test(v))
          return reply.code(400).send({ error: `Setting ${k} has an invalid value` });
        if (validator.readOnly)
          return reply.code(400).send({ error: `Setting ${k} is read-only${validator.hint ? ` (${validator.hint})` : ''}` });
      }
      setSetting(k, v);
    }
    audit('settings.update', JSON.stringify(req.body));
    return { ok: true };
  });

  /* ---------- pages ---------- */
  // Ingested-file mirror pages show their pseudonymised title in the tree, matching Library and Ask
  // (the page itself still holds the real text locally: store-and-mask).
  app.get('/api/space/:key/tree', async (req) => pages.tree(req.params.key)
    .map((r) => (r.type === 'source-capture' ? { ...r, title: guard.mask(r.title) } : r)));

  app.get('/api/page/:id', async (req, reply) => {
    const p = pages.get(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    if (req.query.mask === '1') {
      return { ...p, title: guard.mask(p.title), body_html: guard.mask(p.body_html), masked: true };
    }
    return p;
  });

  app.post('/api/page', async (req, reply) => {
    try {
      const page = pages.create(req.body);
      return page;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.patch('/api/page/:id', async (req, reply) => {
    try {
      validatePagePatch(req.body);
      const page = pages.update(Number(req.params.id), req.body);
      return page;
    } catch (err) {
      const code = err.message === 'not found' ? 404 : 400;
      return reply.code(code).send({ error: err.message });
    }
  });

  app.delete('/api/page/:id', async (req, reply) => {
    try {
      pages.remove(Number(req.params.id));
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: err.message });
    }
  });

  app.get('/api/page/:id/revisions', async (req) => pages.revisions(Number(req.params.id)));
  app.get('/api/revision/:id', async (req) => pages.revision(Number(req.params.id)));

  /* ---------- search ---------- */
  app.get('/api/search', async (req, reply) => {
    const q    = String(req.query.q  || '').trim().slice(0, MAX_Q);
    const mode = String(req.query.mode || 'hybrid');
    if (!['strict', 'fuzzy', 'hybrid'].includes(mode))
      return reply.code(400).send({ error: 'mode must be strict|fuzzy|hybrid' });
    if (!q) return [];
    return search(q, mode, 60);
  });

  /* ---------- entity guard ---------- */
  app.get('/api/entities', async () => guard.listEntities());

  app.post('/api/entities', async (req, reply) => {
    const { canonical, type = 'org', aliases = [] } = req.body || {};
    if (!canonical || !String(canonical).trim())
      return reply.code(400).send({ error: 'canonical is required' });
    const list = Array.isArray(aliases)
      ? aliases
      : String(aliases).split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const e = guard.addEntity({ canonical, type, aliases: list, origin: 'user' });
      scheduleRemask();
      return e;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.delete('/api/entities/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (req.query.purge === '1') {
      try {
        guard.purgeEntity(id, { confirm: true });
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    } else {
      guard.removeEntity(id);
    }
    return { ok: true };
  });

  app.get('/api/review', async () => db().prepare(
    `SELECT o.id, o.surface, o.layer, o.confidence, o.status, o.page_id, o.doc_id,
            COALESCE(p.title, 'document ' || o.doc_id) AS page_title
       FROM entity_occurrence o LEFT JOIN page p ON p.id = o.page_id
      WHERE o.status = 'candidate' AND (o.page_id IS NOT NULL OR o.doc_id IS NOT NULL)
      ORDER BY o.confidence DESC, o.surface LIMIT 300`
  ).all());

  app.post('/api/review/:id', async (req) => {
    const { action, type = 'org' } = req.body || {};
    const occ = db().prepare('SELECT * FROM entity_occurrence WHERE id = ?').get(Number(req.params.id));
    if (!occ) return { ok: false };
    if (action === 'protect') {
      const e = guard.addEntity({ canonical: occ.surface, type, origin: 'ner-accepted' });
      scheduleRemask();
      db().prepare("UPDATE entity_occurrence SET status='confirmed', entity_id=? WHERE id=?").run(e.id, occ.id);
      for (const p of db().prepare('SELECT id, title, body_text FROM page').all()) {
        guard.recordOccurrences(p.id, `${p.title}\n${p.body_text}`);
      }
    } else {
      db().prepare("UPDATE entity_occurrence SET status='ignored' WHERE id=?").run(occ.id);
    }
    return { ok: true };
  });

  app.post('/api/mask', async (req) => ({ masked: guard.mask(String(req.body?.text || '')) }));

  /* ---------- export (masked, egress-checked) ---------- */
  app.get('/api/page/:id/export', async (req, reply) => {
    const p = pages.get(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    if (p.sensitivity === 'Restricted')
      return reply.code(403).send({ error: 'Restricted pages cannot be exported' });
    const body = { title: guard.mask(p.title), html: guard.mask(p.body_html) };
    guard.assertClean(body, 'export');
    const doc = `<!doctype html><meta charset="utf-8"><title>${body.title}</title>` +
      `<h1>${body.title}</h1>${body.html}`;
    const file = path.join(paths.exports, `page-${p.id}.html`);
    fs.writeFileSync(file, doc, 'utf8');
    audit('export', `page=${p.id} -> ${file}`);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${body.title.replace(/[^\w.-]+/g, '_')}.html"`);
    return doc;
  });

  /* ---------- import (.pdf / .docx / .doc / .pptx / .html / .md / .txt / .mhtml) ---------- */
  app.post('/api/import', async (req, reply) => {
    // Multipart upload (any number of files), or JSON { filePath } relative to CADENZZA_HOME/import
    const imported = [], failed = [];
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      for await (const part of req.files()) {
        const buffer = await part.toBuffer();
        try {
          imported.push(await importDocument({
            filename: part.filename,
            buffer,
            space_key: req.query.space || 'release',
            sensitivity: req.query.sensitivity || null
          }));
        } catch (err) {
          failed.push({ filename: part.filename, error: err.message });
        }
      }
      if (!imported.length && !failed.length) return reply.code(400).send({ error: 'No file received' });
      if (!imported.length) return reply.code(400).send({ error: failed[0].error, imported, failed });
      return { imported, failed };
    }

    const { filePath, space_key = 'release', sensitivity = null } = req.body || {};
    if (!filePath) return reply.code(400).send({ error: 'filePath is required' });

    const resolved = resolveImportPath(String(filePath));
    if (!resolved) return reply.code(403).send({ error: 'filePath must be inside the import folder' });
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
      return reply.code(404).send({ error: `File not found: ${path.relative(paths.importRoot, resolved)}` });

    try {
      imported.push(await importDocument({ filename: path.basename(resolved), buffer: fs.readFileSync(resolved), space_key, sensitivity }));
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    return { imported, failed };
  });

  /* ---------- assets upload ---------- */
  app.post('/api/upload', async (req, reply) => {
    const ALLOWED_EXTS = /\.(png|jpe?g|gif|svg|webp|pdf|txt|md|csv|json|xml|docx?|pptx|html?|mhtml?)$/i;
    const parts = req.files ? req.files() : null;
    const saved = [];
    if (parts) {
      for await (const part of parts) {
        const ext = path.extname(part.filename).toLowerCase();
        if (!ALLOWED_EXTS.test(ext)) {
          return reply.code(400).send({ error: `File type not allowed: ${ext}` });
        }
        // Safe filename: strip anything outside word chars, dots, hyphens
        const safe = path.basename(part.filename).replace(/[^\w.\-]+/g, '_').slice(0, 200);
        const dest = path.join(paths.assets, `${Date.now()}-${safe}`);
        await fs.promises.writeFile(dest, await part.toBuffer());
        saved.push({ filename: safe, path: dest });
        audit('asset.upload', safe);
      }
    }
    return { saved };
  });

  /* ---------- ask (SSE): sources -> token* -> [replace] -> done | error ---------- */
  app.post('/api/ask', async (req, reply) => {
    const { question, k, mode, filter = {} } = req.body || {};
    const q = String(question || '').trim();
    if (!q || q.length > 1000) return reply.code(400).send({ error: 'question is required (max 1000 chars)' });
    if (k !== undefined && !(Number.isInteger(k) && k >= 1 && k <= 20)) return reply.code(400).send({ error: 'k must be 1-20' });
    if (mode !== undefined && !['hybrid', 'dense', 'exact'].includes(mode)) return reply.code(400).send({ error: 'mode must be hybrid|dense|exact' });
    const cleanFilter = {};
    for (const key of ['space', 'sensitivity', 'file_type', 'doc_id']) {
      const v = filter[key];
      if (v == null || v === '') continue;
      if (![v].flat().every((x) => typeof x === 'string' && x.length <= 80)) return reply.code(400).send({ error: `invalid filter ${key}` });
      cleanFilter[key] = v;
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    try {
      const result = await askQuestion(q, {
        k, mode, filter: cleanFilter, signal: ac.signal,
        onRetrieval: (sources) => send('sources', sources),
        onToken: (delta) => send('token', { delta }),
        onReplace: (text) => send('replace', { text })
      });
      send('done', result);
    } catch (err) {
      send('error', { error: guard.mask(err.message) });
    }
    res.end();
  });

  /* ---------- explicit, audited reveal of pseudonyms (UI "Reveal names") ---------- */
  app.post('/api/unmask', async (req, reply) => {
    const text = String(req.body?.text || '');
    if (!text || text.length > 50_000) return reply.code(400).send({ error: 'text is required (max 50k chars)' });
    const reason = String(req.body?.reason || 'ui reveal').slice(0, 120);
    audit('reveal.request', `chars=${text.length} reason=${reason}`);
    return { text: guard.unmask(text, reason) };
  });

  app.get('/api/audit', async () => db().prepare(
    'SELECT ts, action, detail FROM audit_event ORDER BY id DESC LIMIT 200'
  ).all());

  await registerRagRoutes(app);

  return app;
}
