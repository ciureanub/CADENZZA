/**
 * Document importer — converts common file formats to a CADENZZA page.
 *
 * Supported:
 *   .mhtml / .mht    Confluence/Outlook MIME HTML export
 *   .html / .htm     Plain HTML
 *   .doc             If it's actually MHTML (Confluence exports as .doc)
 *   .txt             Plain text → wrapped in <p> tags
 *   .md              Markdown → naïve but zero-dep HTML conversion
 *
 * No outbound network calls. No native binary parsers required.
 */

import path from 'node:path';
import * as pages from '../pages.js';

/* ------------------------------------------------------------------ */
/* MIME multipart boundary splitter                                    */
/* ------------------------------------------------------------------ */

function parseMhtml(text) {
  // Find the boundary from Content-Type header
  const boundaryMatch = text.match(/boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) return null;

  const boundary = '--' + boundaryMatch[1];
  const parts = text.split(new RegExp(boundary + '(?:--)?\\s*\\r?\\n')).slice(1);

  for (const part of parts) {
    const [headerBlock, ...bodyLines] = part.split(/\r?\n\r?\n/);
    const headers = headerBlock || '';
    const body = bodyLines.join('\n\n');

    const ctMatch = headers.match(/Content-Type:\s*([^\s;]+)/i);
    const ct = ctMatch ? ctMatch[1].toLowerCase() : '';
    const encMatch = headers.match(/Content-Transfer-Encoding:\s*([^\s]+)/i);
    const enc = encMatch ? encMatch[1].toLowerCase() : '7bit';

    if (!ct.includes('text/html')) continue;

    let decoded = body;
    if (enc === 'quoted-printable') decoded = decodeQP(body);
    else if (enc === 'base64') decoded = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');

    // Attempt charset decode if declared
    const csMatch = headers.match(/charset="?([^"\s;]+)"?/i) ||
                    decoded.match(/charset=["']?([^"'\s;>]+)["']?/i);
    if (csMatch) {
      const cs = csMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cs === 'utf8' || cs === 'utf-8') {
        // already a string — fine
      } else if (cs === 'windows1252' || cs === 'cp1252' || cs === '1252') {
        decoded = decodeWindows1252(decoded);
      }
    }

    return decoded;
  }
  return null;
}

function decodeQP(s) {
  return s
    .replace(/=\r?\n/g, '')                         // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeWindows1252(s) {
  // Map the 0x80-0x9F range that differs from ISO-8859-1
  const map = {
    '\x80': '\u20AC', '\x82': '\u201A', '\x83': '\u0192', '\x84': '\u201E',
    '\x85': '\u2026', '\x86': '\u2020', '\x87': '\u2021', '\x88': '\u02C6',
    '\x89': '\u2030', '\x8A': '\u0160', '\x8B': '\u2039', '\x8C': '\u0152',
    '\x8E': '\u017D', '\x91': '\u2018', '\x92': '\u2019', '\x93': '\u201C',
    '\x94': '\u201D', '\x95': '\u2022', '\x96': '\u2013', '\x97': '\u2014',
    '\x98': '\u02DC', '\x99': '\u2122', '\x9A': '\u0161', '\x9B': '\u203A',
    '\x9C': '\u0153', '\x9E': '\u017E', '\x9F': '\u0178'
  };
  return s.replace(/[\x80-\x9F]/g, (c) => map[c] || c);
}

/* ------------------------------------------------------------------ */
/* HTML cleanup — strip navigation, scripts, styles; keep content     */
/* ------------------------------------------------------------------ */

function extractBody(html) {
  let out = html;

  // Try to pull just the <body> content
  const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) out = bodyMatch[1];

  // Remove <head>, <script>, <style>, <nav>, <header> in body (Confluence nav bars)
  out = out
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    // Confluence breadcrumb / sidebar divs
    .replace(/<div[^>]+id=["'][^"']*(?:breadcrumb|sidebar|footer|header|nav|menu)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]+class=["'][^"']*(?:breadcrumb|sidebar|footer|header|nav|menu)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

  // Extract the title from <h1> or <title>
  let title = '';
  const h1 = out.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) title = stripTags(h1[1]).trim();

  // Sanitise attributes — keep only safe structural ones
  out = sanitiseHtml(out);

  return { title, html: out.trim() };
}

/** Strip every attribute except a small safe set. */
function sanitiseHtml(html) {
  // Remove all event handlers and javascript: hrefs
  return html
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
    .replace(/src\s*=\s*["'](?!data:image)[^"']*["']/gi, 'src=""') // strip external src
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Markdown → HTML (zero-dep, handles basic cases)                    */
/* ------------------------------------------------------------------ */

function mdToHtml(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^(?!<[hul])(.+)$/gm, '$1')
    .replace(/^(.)/m, '<p>$1')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string}  opts.filename    - original filename (for extension detection)
 * @param {Buffer}  opts.buffer      - file contents
 * @param {string}  opts.space_key   - target CADENZZA space
 * @param {string|null} opts.sensitivity - override sensitivity (null = space default)
 * @returns {{ id, title, space_key }} created page
 */
export async function importDocument({ filename, buffer, space_key = 'release', sensitivity = null }) {
  const ext = path.extname(filename).toLowerCase();
  const text = buffer.toString('utf8');

  let title = path.basename(filename, path.extname(filename))
    .replace(/[_+\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let body_html = '';

  /* ---- MHTML / .doc (Confluence exports .doc files that are actually MHTML) ---- */
  if (ext === '.mhtml' || ext === '.mht' || ext === '.doc') {
    const isMhtml = /^(?:MIME-Version|Message-ID|Content-Type:.*multipart)/im.test(text.slice(0, 500));
    if (isMhtml) {
      const htmlContent = parseMhtml(text);
      if (!htmlContent) throw new Error('Could not parse MHTML: no text/html part found');
      const extracted = extractBody(htmlContent);
      if (extracted.title) title = extracted.title;
      body_html = extracted.html;
    } else if (ext === '.doc') {
      // Binary legacy .doc — we can't parse it without a native library.
      // Store a placeholder so the file is at least captured.
      throw new Error(
        'Legacy binary .doc format (OLE Compound) is not supported. ' +
        'Re-save the file as .docx, .html, or .txt from Word and import again.'
      );
    }
  }

  /* ---- Plain HTML ---- */
  else if (ext === '.html' || ext === '.htm') {
    const extracted = extractBody(text);
    if (extracted.title) title = extracted.title;
    body_html = extracted.html;
  }

  /* ---- Markdown ---- */
  else if (ext === '.md' || ext === '.markdown') {
    // Extract first heading as title if present
    const h1 = text.match(/^#\s+(.+)/m);
    if (h1) title = h1[1].trim();
    body_html = mdToHtml(text);
  }

  /* ---- Plain text ---- */
  else if (ext === '.txt') {
    body_html = '<p>' + text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br>') + '</p>';
  }

  else {
    throw new Error(`Unsupported file type: ${ext}. Supported: .mhtml, .mht, .doc (MHTML), .html, .htm, .md, .txt`);
  }

  if (!title) title = 'Imported Document';

  const page = pages.create({
    space_key,
    title,
    body_html,
    type: 'note',
    sensitivity: sensitivity || undefined
  });

  return { id: page.id, title: page.title, space_key };
}
