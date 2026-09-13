// Only used after strict XML parsing failed. Ambiguous boundaries are never repaired.
const NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
const TAG = new RegExp(`^<(/?)(${NAME})(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`);
const MARKUP = /^<\/?[\p{L}_:]/u;
const XML_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;

function payloadProblem(payload) {
  if (XML_CONTROLS.test(payload)) return 'invalid-xml-character';
  const compact = payload.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/[\t\n\r ]/g, '');
  if (/[^A-Za-z0-9+/=]/.test(compact)) return 'non-base64-data';
  const padding = compact.indexOf('=');
  if (compact.length % 4 || (padding >= 0 && (padding < compact.length - 2 || !/^={1,2}$/.test(compact.slice(padding))))) return 'invalid-base64-length-or-padding';
  return null;
}

function binaryEnd(text, start, name) {
  const closing = new RegExp(`^</${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`);
  let position = start;
  while (position < text.length) {
    const next = text.indexOf('<', position);
    if (next < 0) return null;
    const match = closing.exec(text.slice(next));
    if (match) return { start: next, end: next + match[0].length };
    const delimiter = text.startsWith('<!--', next) ? ['<!--', '-->']
      : text.startsWith('<![CDATA[', next) ? ['<![CDATA[', ']]>'] : null;
    if (delimiter) {
      const end = text.indexOf(delimiter[1], next + delimiter[0].length);
      if (end < 0) return null;
      position = end + delimiter[1].length;
      continue;
    }
    // A missing closing tag must never swallow book structure or another attachment.
    if (MARKUP.test(text.slice(next)) || text.startsWith('<!', next) || text.startsWith('<?', next)) return null;
    position = next + 1;
  }
  return null;
}

function scanBinaryPayloads(text) {
  const stack = [];
  const binaries = [];
  let rootSeen = false;
  let binaryIndex = 0;
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('<', position);
    if (start < 0) break;
    // Do not mistake text inside comments, CDATA or processing instructions for elements.
    const delimiter = text.startsWith('<!--', start) ? ['<!--', '-->']
      : text.startsWith('<![CDATA[', start) ? ['<![CDATA[', ']]>']
        : text.startsWith('<?', start) ? ['<?', '?>'] : null;
    if (delimiter) {
      const end = text.indexOf(delimiter[1], start + delimiter[0].length);
      if (end < 0) return null;
      position = end + delimiter[1].length;
      continue;
    }
    // DTDs and malformed markup outside payloads are deliberately unsupported here.
    const tag = TAG.exec(text.slice(start));
    if (!tag) return null;
    const [raw, closing, name] = tag;
    const end = start + raw.length;
    const selfClosing = /\/\s*>$/.test(raw);
    if (closing) {
      if (stack.pop() !== name) return null;
    } else {
      if (!stack.length) {
        if (rootSeen || name.split(':').at(-1) !== 'FictionBook') return null;
        rootSeen = true;
      }
      const isBinary = stack.length === 1 && name.split(':').at(-1) === 'binary';
      const ordinal = isBinary ? binaryIndex++ : -1;
      if (isBinary && !selfClosing) {
        const close = binaryEnd(text, end, name);
        if (!close) return null;
        binaries.push({ start: end, end: close.start, ordinal, reason: payloadProblem(text.slice(end, close.start)) });
        position = close.end;
        continue;
      }
      if (!selfClosing) stack.push(name);
    }
    position = end;
  }
  return rootSeen && !stack.length ? binaries : null;
}

export function recoverBinaryXml(text, Parser) {
  const ranges = scanBinaryPayloads(text);
  const damaged = ranges?.filter((range) => range.reason);
  if (!damaged?.length) return null;
  const chunks = [];
  let previous = 0;
  for (const range of damaged) {
    chunks.push(text.slice(previous, range.start));
    previous = range.end;
  }
  chunks.push(text.slice(previous));
  const document = new Parser().parseFromString(chunks.join(''), 'application/xml');
  if (document.querySelector('parsererror')) return null;
  const root = document.documentElement;
  if (root.localName !== 'FictionBook') return null;
  const allBinaries = [...root.children].filter((element) => element.localName === 'binary');
  const result = [];
  for (const range of damaged) {
    // Read attributes from the validated DOM, resolving namespaces and entity references.
    const element = allBinaries[range.ordinal];
    if (!element || element.namespaceURI !== root.namespaceURI || element.textContent) return null;
    result.push({ id: element.getAttribute('id') || '', contentType: element.getAttribute('content-type') || '',
      reason: range.reason, payloadLength: range.end - range.start });
  }
  return { document, binaries: result };
}

export function xmlParserDiagnostics(document) {
  const error = document.querySelector('parsererror');
  const text = error?.textContent || '';
  const location = /(?:on\s+)?line\s+(\d+)(?:\s+at)?\s+column\s+(\d+)/i.exec(text);
  // Whitelist diagnostic phrases: parser output can otherwise contain source text/payload.
  const reason = text.match(/PCDATA invalid Char value \d+|(?:xmlParseCharRef: )?invalid xmlChar value \d+|EntityRef: expecting ';'|StartTag: invalid element name|Extra content at the end of the document|attributes construct error|Opening and ending tag mismatch|Premature end of data|Couldn't find end of Start Tag/i);
  return { parserLine: location ? Number(location[1]) : null, parserColumn: location ? Number(location[2]) : null,
    parserMessage: reason?.[0] || 'Strict XML parser rejected the document; source text omitted.' };
}
