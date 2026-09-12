let dictionaryPromise = null;

export function loadGenreDictionary(fetcher = fetch) {
  if (!dictionaryPromise) {
    const url = new URL('../data/genres-ru.json', import.meta.url);
    dictionaryPromise = fetcher(url).then((response) => {
      if (!response.ok) throw new Error('Genre dictionary is unavailable.');
      return response.json();
    });
  }
  return dictionaryPromise;
}

export async function genreLabels(codes, loader = loadGenreDictionary) {
  const source = Array.isArray(codes) ? codes.filter((code) => typeof code === 'string' && code.trim()) : [];
  if (!source.length) return 'Жанр не указан';
  try {
    const dictionary = await loader();
    return source.map((code) => dictionary[code] || code).join(', ');
  } catch {
    return source.join(', ');
  }
}
