import { formatIndexingErrors } from './indexing-errors.js';
import { latestBookOutcomes } from './indexing-state.js';

const ERROR_LABELS = {
  binary_file: 'Не распознан как FB2/XML',
  not_xml_html: 'HTML-файл вместо FB2',
  not_xml_rtf: 'RTF-файл вместо FB2',
  invalid_xml: 'Повреждённый XML/FB2',
  malformed_zip: 'Повреждённый ZIP',
  zip_no_fb2: 'ZIP не содержит FB2',
  zip_compressed_limit_exceeded: 'ZIP превышает безопасный лимит',
};
const isWarning = (entry) => ['binary_corruption_recovered', 'metadata_only_recovered'].includes(entry.code);

function renderEntry(entry) {
  const item = document.createElement('li');
  item.className = 'indexing-error-entry';
  const name = document.createElement('strong');
  name.textContent = entry.fileName || entry.fileId || 'Индекс';
  const code = document.createElement('p');
  code.textContent = ERROR_LABELS[entry.code] || entry.code || 'Ошибка';
  item.append(name, code);
  if (entry.path) {
    const path = document.createElement('p');
    path.className = 'indexing-error-path';
    path.textContent = `Путь: ${entry.path}`;
    item.append(path);
  }
  if (entry.fileId && ['failed', 'recovered'].includes(entry.outcome)) {
    const link = document.createElement('a');
    link.className = 'indexing-error-drive';
    link.textContent = 'Открыть в Drive';
    link.href = `https://drive.google.com/file/d/${encodeURIComponent(entry.fileId)}/view`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.append(link);
  }
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Технические подробности';
  const text = document.createElement('pre');
  text.textContent = formatIndexingErrors([entry]);
  if (entry.outcome === 'recovered' && !isWarning(entry)) text.textContent += '\n(повтор успешен)';
  details.append(summary, text);
  item.append(details);
  return item;
}

export function createIndexingErrorsController(root) {
  let entries = [];
  if (!root) return { update() {}, reset() {} };
  const count = root.querySelector('[data-error-count]');
  const toggle = root.querySelector('[data-error-toggle]');
  const panel = root.querySelector('[data-error-panel]');
  const list = root.querySelector('[data-error-list]');
  const filter = root.querySelector('[data-error-filter]');
  const otherList = root.querySelector('[data-other-list]');
  const otherHeading = root.querySelector('[data-other-heading]');
  let failedEntries = [];
  const renderFailed = () => {
    list.replaceChildren(...failedEntries.filter((entry) => !filter.value || (entry.code || 'error') === filter.value).map(renderEntry));
  };
  filter.addEventListener('change', renderFailed);
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
      failedEntries = [...latestBookOutcomes(entries).values()].filter((entry) => entry.outcome === 'failed');
      const failed = failedEntries.length;
      const recovered = entries.filter((entry) => entry.outcome === 'recovered').length;
      const warnings = entries.filter((entry) => entry.outcome === 'recovered' && isWarning(entry)).length;
      const preserved = entries.filter((entry) => entry.previousEntryPreserved).length;
      const excluded = entries.filter((entry) => entry.outcome === 'excluded').length;
      const interrupted = entries.filter((entry) => entry.outcome === 'interrupted').length;
      count.textContent = `Ошибок: ${failed}. Предупреждений: ${warnings}. Восстановлено повтором: ${recovered - warnings}. Сохранены из предыдущего индекса: ${preserved}.`
        + (interrupted ? ` Прерываний: ${interrupted}.` : '')
        + (excluded ? ` Больше нет в библиотеке: ${excluded}.` : '');
      const selected = filter.value;
      const codes = new Map();
      for (const entry of failedEntries) codes.set(entry.code || 'error', (codes.get(entry.code || 'error') || 0) + 1);
      const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
      filter.replaceChildren(option('', `Все ошибки (${failed})`), ...[...codes].sort(([a], [b]) => a.localeCompare(b))
        .map(([code, total]) => option(code, `${code} (${total})`)));
      filter.value = codes.has(selected) ? selected : '';
      renderFailed();
      recoveredList.replaceChildren(...entries.filter((entry) => entry.outcome === 'recovered').map(renderEntry));
      recoveredList.hidden = recoveredHeading.hidden = !recovered;
      const active = new Set(failedEntries);
      const other = entries.filter((entry) => entry.outcome !== 'recovered' && !active.has(entry));
      otherList.replaceChildren(...other.map(renderEntry));
      otherList.hidden = otherHeading.hidden = !other.length;
    },
    reset() { this.update([]); panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = 'Показать'; fallback.hidden = true; message.textContent = ''; },
  };
}
