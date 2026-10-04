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

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

const VALID_SETTINGS = {
  storage_mode:    { enum: ['store-and-mask'] },
  pseudonym_style: { enum: ['coded', 'plausible'] },
  chat_mode:       { enum: ['private', 'public'] },
  offline:         { enum: ['1', '0'] }
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
      offline:         getSetting('offline')
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
      }
      setSetting(k, v);
    }
    audit('settings.update', JSON.stringify(req.body));
    return { ok: true };
  });

  /* ---------- pages ---------- */
  app.get('/api/space/:key/tree', async (req) => pages.tree(req.params.key));

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
      return guard.addEntity({ canonical, type, aliases: list, origin: 'user' });
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
    `SELECT o.id, o.surface, o.layer, o.confidence, o.status, o.page_id, p.title AS page_title
       FROM entity_occurrence o JOIN page p ON p.id = o.page_id
      WHERE o.status = 'candidate'
      ORDER BY o.confidence DESC, o.surface LIMIT 300`
  ).all());

  app.post('/api/review/:id', async (req) => {
    const { action, type = 'org' } = req.body || {};
    const occ = db().prepare('SELECT * FROM entity_occurrence WHERE id = ?').get(Number(req.params.id));
    if (!occ) return { ok: false };
    if (action === 'protect') {
      const e = guard.addEntity({ canonical: occ.surface, type, origin: 'ner-accepted' });
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

  /* ---------- import (.mhtml / .mht / .doc-as-MHTML / .html / .md / .txt) ---------- */
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
    const ALLOWED_EXTS = /\.(png|jpe?g|gif|svg|webp|pdf|txt|md|csv|json|xml)$/i;
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

  app.get('/api/audit', async () => db().prepare(
    'SELECT ts, action, detail FROM audit_event ORDER BY id DESC LIMIT 200'
  ).all());

  return app;
}
