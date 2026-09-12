import { seriesName, seriesNumber } from './book-series.js';
import { compareCatalogBooks } from './library-view-model.js';

export function filterBooksByDirectValue(books, filter) {
  const source = Array.isArray(books) ? books : [];
  if (!filter || typeof filter.value !== 'string') return [];
  if (filter.type === 'series') {
    const name = filter.value.trim();
    if (!name) return [];
    return source.filter((book) => seriesName(book) === name).sort((a, b) => {
      const first = seriesNumber(a);
      const second = seriesNumber(b);
      if (first === null && second !== null) return 1;
      if (first !== null && second === null) return -1;
      return (first !== null && second !== null ? first - second : 0) || compareCatalogBooks(a, b);
    });
  }
  if (filter.type === 'genre') {
    return source.filter((book) => Array.isArray(book.genres) && book.genres.includes(filter.value));
  }
  if (filter.type === 'author') {
    const author = filter.value.trim();
    return source.filter((book) => Array.isArray(book.authors)
      && book.authors.some((value) => typeof value === 'string' && value.trim() === author));
  }
  return [];
}

export function russianBookCount(count) {
  const absolute = Math.abs(Number(count)) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return `${count.toLocaleString('ru-RU')} книг`;
  if (last === 1) return `${count.toLocaleString('ru-RU')} книга`;
  if (last >= 2 && last <= 4) return `${count.toLocaleString('ru-RU')} книги`;
  return `${count.toLocaleString('ru-RU')} книг`;
}
