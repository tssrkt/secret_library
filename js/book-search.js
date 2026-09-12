export function normalizeSearchText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

export function emptySearchState() {
  return { query: '', title: '', author: '', series: '', genre: '', language: '', page: 1 };
}

export function searchBooks(books, conditions = {}) {
  const words = normalizeSearchText(conditions.query).split(' ').filter(Boolean);
  const title = normalizeSearchText(conditions.title);
  const author = normalizeSearchText(conditions.author);
  const series = normalizeSearchText(conditions.series);
  return (Array.isArray(books) ? books : []).filter((book) => {
    const authors = Array.isArray(book.authors) ? book.authors.map(normalizeSearchText) : [];
    const values = [book.title, book.series, book.annotation, book.fileName].map(normalizeSearchText).concat(authors);
    return words.every((word) => values.some((value) => value.includes(word)))
      && (!title || normalizeSearchText(book.title).includes(title))
      && (!author || authors.some((value) => value.includes(author)))
      && (!series || normalizeSearchText(book.series).includes(series))
      && (!conditions.genre || (Array.isArray(book.genres) && book.genres.includes(conditions.genre)))
      && (!conditions.language || book.language === conditions.language);
  });
}

export function librarySearchOptions(books, genresRu = {}) {
  const genres = new Set();
  const languages = new Set();
  for (const book of Array.isArray(books) ? books : []) {
    for (const code of Array.isArray(book.genres) ? book.genres : []) {
      if (typeof code === 'string' && code.trim()) genres.add(code);
    }
    if (typeof book.language === 'string' && book.language.trim()) languages.add(book.language);
  }
  let names;
  try { names = new Intl.DisplayNames(['ru'], { type: 'language' }); } catch {}
  const languageLabel = (value) => {
    try { return names?.of(value) || value; } catch { return value; }
  };
  const options = (values, label) => [...values].map((value) => ({ value, label: label(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru') || a.value.localeCompare(b.value));
  return { genres: options(genres, (code) => genresRu[code] || code), languages: options(languages, languageLabel) };
}
