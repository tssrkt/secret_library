import { formatIndexingErrors } from './indexing-errors.js';

export function createIndexingErrorsController(root) {
  let entries = [];
  if (!root) return { update() {}, reset() {} };
  const count = root.querySelector('[data-error-count]');
  const toggle = root.querySelector('[data-error-toggle]');
  const panel = root.querySelector('[data-error-panel]');
  const list = root.querySelector('[data-error-list]');
  const recoveredList = root.querySelector('[data-recovered-list]');
  const recoveredHeading = root.querySelector('[data-recovered-heading]');
  const fallback = root.querySelector('textarea');
  const message = root.querySelector('[role="status"]');
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    toggle.textContent = panel.hidden ? 'Показать' : 'Скрыть';
  });
  root.querySelector('[data-error-copy]').addEventListener('click', async () => {
    const report = formatIndexingErrors(entries);
    try {
      await navigator.clipboard.writeText(report);
      message.textContent = 'Ошибки скопированы.';
    } catch {
      fallback.hidden = false;
      fallback.value = report;
      fallback.focus();
      fallback.select();
      message.textContent = 'Буфер обмена недоступен. Скопируйте выделенный отчёт вручную.';
    }
  });
  root.querySelector('[data-error-download]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([formatIndexingErrors(entries)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'secret-library-indexing-errors.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return {
    update(next = []) {
      entries = next;
      root.hidden = !entries.length;
      const failed = entries.filter((entry) => entry.outcome === 'failed').length;
      const recovered = entries.filter((entry) => entry.outcome === 'recovered').length;
      const warnings = entries.filter((entry) => entry.outcome === 'recovered' && entry.code === 'binary_corruption_recovered').length;
      const preserved = entries.filter((entry) => entry.previousEntryPreserved).length;
      const excluded = entries.filter((entry) => entry.outcome === 'excluded').length;
      const interrupted = entries.length - failed - recovered - excluded;
      count.textContent = `Ошибок: ${failed}. Предупреждений: ${warnings}. Восстановлено повтором: ${recovered - warnings}. Сохранены из предыдущего индекса: ${preserved}.`
        + (interrupted ? ` Прерываний: ${interrupted}.` : '')
        + (excluded ? ` Больше нет в библиотеке: ${excluded}.` : '');
      const renderEntry = (entry) => {
        const item = document.createElement('li');
        item.textContent = `${entry.fileName || entry.fileId || 'Индекс'} — ${entry.stage} — ${entry.status ? `HTTP ${entry.status}` : entry.code}: ${entry.message}`
          + (entry.outcome === 'recovered' && entry.code !== 'binary_corruption_recovered' ? ' (повтор успешен)' : '')
          + (entry.binaries ? ` Вложения: ${entry.binaries.map((binary) => binary.id || '(без id)').join(', ')}.` : '')
          + (entry.previousCoverPreserved ? ' (предыдущая обложка сохранена)' : '')
          + (entry.previousEntryPreserved ? ' (старая запись сохранена)' : '');
        return item;
      };
      list.replaceChildren(...entries.filter((entry) => entry.outcome !== 'recovered').map(renderEntry));
      recoveredList.replaceChildren(...entries.filter((entry) => entry.outcome === 'recovered').map(renderEntry));
      recoveredList.hidden = recoveredHeading.hidden = !recovered;
    },
    reset() { this.update([]); panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = 'Показать'; fallback.hidden = true; message.textContent = ''; },
  };
}
