// Locate structure only; all metadata is read later from a strictly parsed DOM.
// Stop at the description boundary: never inspect or repair damaged body/binary.
const TAG = /^<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/;

export function recoverDescriptionXml(text, Parser, diagnostics = {}) {
  Object.assign(diagnostics, { attempted: true, result: 'rejected', reason: 'metadata-recovery-boundary-not-found', descriptionValid: false });
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let root = null; let descriptionStart = -1; const stack = [];
  while (position < text.length) {
    const start = text.indexOf('<', position);
    if (start < 0) return null;
    if (descriptionStart < 0 && text.slice(position, start).trim()) return null;
    const delimiter = text.startsWith('<!--', start) ? ['<!--', '-->']
      : text.startsWith('<?', start) ? ['<?', '?>']
        : descriptionStart >= 0 && text.startsWith('<![CDATA[', start) ? ['<![CDATA[', ']]>'] : null;
    if (delimiter) {
      const end = text.indexOf(delimiter[1], start + delimiter[0].length);
      if (end < 0) return null;
      position = end + delimiter[1].length; continue;
    }
    const tag = TAG.exec(text.slice(start));
    if (!tag) return null;
    const [raw, closing, name] = tag;
    const local = name.split(':').at(-1);
    const selfClosing = /\/\s*>$/.test(raw);
    position = start + raw.length;
    if (!root) {
      if (closing || selfClosing || local !== 'FictionBook') return null;
      root = { raw, name }; stack.push(name); continue;
    }
    if (descriptionStart < 0) {
      if (closing || local !== 'description' || selfClosing) return null;
      descriptionStart = start;
    } else if (!closing && local === 'description') {
      diagnostics.reason = 'metadata-recovery-ambiguous'; return null;
    }
    if (closing) {
      if (stack.pop() !== name) { diagnostics.reason = 'metadata-recovery-ambiguous'; return null; }
      if (stack.length === 1) {
        const document = new Parser().parseFromString(`${root.raw}${text.slice(descriptionStart, position)}</${root.name}>`, 'application/xml');
        const element = document.documentElement;
        const description = element?.children[0];
        if (document.querySelector('parsererror') || element?.localName !== 'FictionBook'
            || element.children.length !== 1 || description?.localName !== 'description'
            || description.namespaceURI !== element.namespaceURI) {
          diagnostics.reason = 'description-xml-invalid'; return null;
        }
        Object.assign(diagnostics, { result: 'recovered', reason: 'strict-description-valid', descriptionValid: true });
        return document;
      }
    } else if (!selfClosing) stack.push(name);
  }
  return null;
}
