// Diagnostic signatures only. Never convert another format into FB2.
export function sniffFb2(bytes, text = '') {
  const starts = (...values) => values.every((value, i) => bytes[i] === value);
  const bom = starts(0xef, 0xbb, 0xbf) ? 'utf-8' : starts(0xff, 0xfe) ? 'utf-16le'
    : starts(0xfe, 0xff) ? 'utf-16be' : null;
  const prefix = text.slice(0, 1024).replace(/^\uFEFF/, '').trimStart();
  const xmlDeclaration = /^<\?xml\s/i.test(prefix);
  const content = prefix.replace(/^<\?xml\s[^?]*\?>\s*/i, '');
  let classification = null;
  if (starts(0x50, 0x4b, 3, 4) || starts(0x50, 0x4b, 5, 6)) classification = 'unexpected_zip';
  else if (starts(0x1f, 0x8b)) classification = 'unexpected_gzip';
  else if (/^(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(content)) classification = 'not_xml_html';
  else if (/^\{\\rtf\d/i.test(content)) classification = 'not_xml_rtf';
  else if (starts(0xff, 0xd8, 0xff) || starts(0x89, 0x50, 0x4e, 0x47)
    || (!bom && !prefix.startsWith('<') && bytes.subarray(0, 64).filter((value) => value === 0).length > 8)) classification = 'binary_file';
  return { bom, xmlDeclaration, classification };
}
