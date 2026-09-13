import { Fb2Error } from './fb2.js';

// Detached, inert parsing only. Nothing from a book is inserted into the app DOM.
export class BookFormatError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BookFormatError'; this.code = code; this.stage = 'parse'; }
}

export function emptyBookMetadata() {
  return { title: null, authors: [], genres: [], series: null, seriesNumber: null,
    annotation: null, preview: null, language: null };
}

export function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
export function uniqueText(values) { return [...new Set(values.map(cleanText).filter(Boolean))]; }
export function seriesNumber(value) { return value != null && String(value).trim() && Number.isFinite(Number(value)) ? Number(value) : null; }

export function inertHtml(html) {
  // A template's content is inert (including images/iframes); DOMParser HTML
  // documents can otherwise initiate resource fetches in some browsers.
  const template = document.createElement('template');
  template.innerHTML = String(html);
  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,svg,math,noscript').forEach((node) => node.remove());
  return template.content;
}

export function plainDescription(html) {
  const root = inertHtml(html);
  root.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  root.querySelectorAll('p,div,li').forEach((node) => node.append('\n\n'));
  return root.textContent.split(/\n\s*\n/).map(cleanText).filter(Boolean).join('\n\n') || null;
}

export function htmlPreview(html) {
  const root = inertHtml(html);
  root.querySelectorAll('nav,header,footer,[hidden],[role="doc-toc"],[epub\\:type="toc"],[epub\\:type="copyright-page"]').forEach((node) => node.remove());
  const paragraphs = [...root.querySelectorAll('p')].filter((node) => !node.querySelector('a')
    && !node.closest('[epub\\:type="titlepage"], [epub\\:type="cover"]'));
  const blocks = [];
  let length = 0;
  for (const node of paragraphs) {
    let text = cleanText(node.textContent);
    if ((text.match(/[\p{L}\p{N}]+/gu) || []).length < 3) continue;
    const left = 1200 - length - (blocks.length ? 2 : 0);
    if (text.length > left) { text = text.slice(0, left); const boundary = text.lastIndexOf(' '); if (boundary > 0) text = text.slice(0, boundary); }
    if (text) { blocks.push(text); length += text.length + (blocks.length > 1 ? 2 : 0); }
    if (length >= 800) break;
  }
  return blocks.join('\n\n') || null;
}

export async function usableCover(bytes, signal) {
  signal?.throwIfAborted();
  const prefix = String.fromCharCode(...bytes.subarray(0, 12));
  const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : prefix.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
      : /^GIF8[79]a/.test(prefix) ? 'image/gif'
        : prefix.startsWith('RIFF') && prefix.slice(8) === 'WEBP' ? 'image/webp' : null;
  if (!mimeType) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    bitmap.close();
    signal?.throwIfAborted();
    return { bytes, mimeType };
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

// Missing/unsupported optional content does not erase metadata; real network
// errors, 416 and authorization failures still reach the existing retry flow.
export async function optionalResource(action) {
  try { return await action(); }
  catch (error) { if (error.name === 'AbortError' || error.status || !(error instanceof BookFormatError || error instanceof Fb2Error)) throw error; return null; }
}
