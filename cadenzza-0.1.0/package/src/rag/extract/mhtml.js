/**
 * MHTML / MHT (Confluence, Outlook, Word "Single File Web Page"; also Confluence ".doc" exports).
 * Works on raw bytes: transfer-decode first, then charset-decode — fixes the old mojibake (N3).
 */
import { decodeBytes } from './common.js';
import { fromHtmlString } from './html.js';

/** True if the buffer starts like a MIME message. */
export function isMhtml(buffer) {
  return /^(?:\s*(?:MIME-Version|Message-ID|Content-Type:\s*multipart|From:|Subject:|Date:|X-[\w-]+:))/im
    .test(buffer.subarray(0, 600).toString('latin1'));
}

/** Quoted-printable -> bytes. */
export function decodeQP(latin1) {
  const s = latin1.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** First text/html part of a MIME multipart message, decoded to a string; null if none. */
export function htmlPart(buffer) {
  const text = buffer.toString('latin1'); // byte-preserving
  const b = text.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!b) return null;
  const esc = b[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`--${esc}(?:--)?[ \\t]*\\r?\\n?`)).slice(1);

  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const body = part.slice(split).replace(/^\r?\n\r?\n/, '');
    if (!/Content-Type:\s*text\/html/i.test(headers)) continue;

    const enc = (headers.match(/Content-Transfer-Encoding:\s*([^\s;]+)/i) || [])[1]?.toLowerCase() || '7bit';
    const bytes = enc === 'quoted-printable' ? decodeQP(body)
      : enc === 'base64' ? Buffer.from(body.replace(/\s/g, ''), 'base64')
      : Buffer.from(body, 'latin1');

    const declared = (headers.match(/charset="?([^"\s;]+)"?/i) || [])[1]
      || (bytes.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1];
    return decodeBytes(bytes, declared);
  }
  return null;
}

export function extractMhtml(buffer, filename) {
  const html = htmlPart(buffer);
  if (html == null) throw new Error('Could not parse MHTML: no text/html part found');
  return fromHtmlString(html, filename, 'mhtml');
}
