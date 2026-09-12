export const BOOKS_PER_PAGE = 50;

export function paginateItems(items, currentPage = 1, pageSize = BOOKS_PER_PAGE) {
  const safeItems = Array.isArray(items) ? items : [];
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : BOOKS_PER_PAGE;
  const totalItems = safeItems.length;
  const totalPages = Math.ceil(totalItems / safePageSize);
  const requestedPage = Number.isFinite(Number(currentPage)) ? Math.trunc(Number(currentPage)) : 1;
  const page = totalPages ? Math.min(Math.max(1, requestedPage), totalPages) : 1;
  const start = (page - 1) * safePageSize;
  return {
    totalItems,
    totalPages,
    currentPage: page,
    pageSize: safePageSize,
    items: safeItems.slice(start, start + safePageSize),
  };
}

export function paginationTokens(totalPages, currentPage) {
  if (totalPages <= 1) return [];
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
  if (currentPage >= totalPages - 3) {
    return [1, 'ellipsis', ...Array.from({ length: 5 }, (_, index) => totalPages - 4 + index)];
  }
  return [1, 'ellipsis', currentPage - 2, currentPage - 1, currentPage, currentPage + 1, currentPage + 2, 'ellipsis', totalPages];
}

export function createPaginator({ totalPages, currentPage, onPageChange, documentRef = document }) {
  if (totalPages <= 1) return null;
  const navigation = documentRef.createElement('nav');
  navigation.className = 'book-pagination';
  navigation.setAttribute('aria-label', 'Страницы книг');

  const addButton = (label, page, { disabled = false, current = false, ariaLabel = '' } = {}) => {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'book-pagination-button';
    button.textContent = label;
    button.disabled = disabled;
    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    if (current) button.setAttribute('aria-current', 'page');
    if (!disabled && !current) button.addEventListener('click', () => onPageChange(page));
    navigation.append(button);
  };

  addButton('←', currentPage - 1, { disabled: currentPage === 1, ariaLabel: 'Предыдущая страница' });
  for (const token of paginationTokens(totalPages, currentPage)) {
    if (token === 'ellipsis') {
      const ellipsis = documentRef.createElement('span');
      ellipsis.className = 'book-pagination-ellipsis';
      ellipsis.textContent = '…';
      ellipsis.setAttribute('aria-hidden', 'true');
      navigation.append(ellipsis);
    } else {
      addButton(String(token), token, { current: token === currentPage, ariaLabel: `Страница ${token}` });
    }
  }
  addButton('→', currentPage + 1, { disabled: currentPage === totalPages, ariaLabel: 'Следующая страница' });
  return navigation;
}
