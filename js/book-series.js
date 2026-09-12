export function seriesName(book) {
  return typeof book.series === 'string' ? book.series.trim() : '';
}

export function seriesNumber(book) {
  const value = book.seriesNumber;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function seriesLabel(book) {
  const name = seriesName(book);
  if (!name) return '';
  const number = seriesNumber(book);
  return number === null ? name : `${name} (${number})`;
}
