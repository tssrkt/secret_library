export const MINIMUM_LIBRARY_BOOKS = 10;

export function hasMinimumBooks(index, minimum = MINIMUM_LIBRARY_BOOKS) {
  return Array.isArray(index?.books) && index.books.length >= minimum;
}
