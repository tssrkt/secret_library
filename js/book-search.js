export function normalizeSearchText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

export function emptySearchState() {
  return { query: '', title: '', author: '', series: '', genre: '', language: '', page: 1 };
}

export function normalizeSearchLanguage(value) {
  const normalized = normalizeSearchText(value).replaceAll('_', '-');
  if (!normalized) return { value: '', label: '', key: '' };
  let base = normalized;
  try { base = new Intl.Locale(normalized).language; }
  catch {
    try { base = Intl.getCanonicalLocales(normalized)[0].split('-')[0]; } catch { /* Keep nonstandard text. */ }
  }
  let label = base;
  try { label = new Intl.DisplayNames(['ru'], { type: 'language', fallback: 'none' }).of(base) || ''; }
  catch { label = ''; }
  if (!label) return { value: normalized, label: normalized, key: `code:${normalized}` };
  return { value: base, label, key: `language:${normalizeSearchText(label)}` };
}

function languageNormalizer() {
  const cache = new Map();
  return (value) => {
    const key = normalizeSearchText(value).replaceAll('_', '-');
    if (!cache.has(key)) cache.set(key, normalizeSearchLanguage(key));
    return cache.get(key);
  };
}

export function searchBooks(books, conditions = {}) {
  const words = normalizeSearchText(conditions.query).split(' ').filter(Boolean);
  const title = normalizeSearchText(conditions.title);
  const author = normalizeSearchText(conditions.author);
  const series = normalizeSearchText(conditions.series);
  const normalizeLanguage = languageNormalizer();
  const language = normalizeLanguage(conditions.language).key;
  return (Array.isArray(books) ? books : []).filter((book) => {
    const authors = Array.isArray(book.authors) ? book.authors.map(normalizeSearchText) : [];
    const values = [book.title, book.series, book.annotation, book.fileName].map(normalizeSearchText).concat(authors);
    return words.every((word) => values.some((value) => value.includes(word)))
      && (!title || normalizeSearchText(book.title).includes(title))
      && (!author || authors.some((value) => value.includes(author)))
      && (!series || normalizeSearchText(book.series).includes(series))
      && (!conditions.genre || (Array.isArray(book.genres) && book.genres.includes(conditions.genre)))
      && (!language || normalizeLanguage(book.language).key === language);
  });
}

export function librarySearchOptions(books, genresRu = {}) {
  const genres = new Set();
  const languages = new Map();
  const normalizeLanguage = languageNormalizer();
  for (const book of Array.isArray(books) ? books : []) {
    for (const code of Array.isArray(book.genres) ? book.genres : []) {
      if (typeof code === 'string' && code.trim()) genres.add(code);
    }
    const language = normalizeLanguage(book.language);
    if (language.key) {
      const previous = languages.get(language.key);
      if (!previous || language.value < previous.value) languages.set(language.key, language);
    }
  }
  const options = (values, label) => [...values].map((value) => ({ value, label: label(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru') || a.value.localeCompare(b.value));
  return { genres: options(genres, (code) => genresRu[code] || code),
    languages: [...languages.values()].map(({ value, label }) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru') || a.value.localeCompare(b.value)),
  };
}
