import { createIndexingErrorsController } from '../js/indexing-errors-ui.js';
import { recordIndexingError, formatIndexingErrors } from '../js/indexing-errors.js';
import { scanLibrary, preserveBookMetadata } from '../js/library-tree.js';
import { failedBookIds } from '../js/indexing-state.js';
import { prepareBuildingIndex, validateCompletedIndex } from '../js/index-build.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { createRetryEligibilityCheck } from '../js/indexing-run.js';

const entry = (fileId, code = 'binary_file', extra = {}) => ({ fileId, fileName: 'book.fb2', code,
  outcome: 'failed', stage: 'parse', message: 'Failed', ...extra });

export async function runDriveErrorJournalTests(test, assert, equal) {
  const markup = await (await fetch('../index.html')).text();
  const fixture = () => {
    const root = new DOMParser().parseFromString(markup, 'text/html').querySelector('#indexing-errors');
    document.body.append(root);
    return { root, controller: createIndexingErrorsController(root) };
  };
  await test('failed Drive links use exact IDs, legacy records and Unicode paths are safe without requests', async () => {
    const { root, controller } = fixture();
    const originalFetch = window.fetch;
    window.fetch = () => { throw new Error('Journal must not fetch Drive'); };
    try {
      const path = 'Библиотека / Чехов & <Рассказы> / (📚) book.fb2';
      controller.update([entry('AAA', 'binary_file', { path }), entry('BBB', 'invalid_xml'), entry('abc123')]);
      const links = [...root.querySelectorAll('[data-error-list] a')];
      equal(links.map((link) => link.href), ['https://drive.google.com/file/d/AAA/view', 'https://drive.google.com/file/d/BBB/view', 'https://drive.google.com/file/d/abc123/view'], 'duplicate filenames never determine URL');
      assert(links.every((link) => link.target === '_blank' && link.rel.includes('noopener') && link.textContent === 'Открыть в Drive'), 'native new-context links');
      equal(root.querySelector('.indexing-error-path').textContent, `Путь: ${path}`, 'literal Unicode diagnostic');
      equal(root.querySelectorAll('.indexing-error-path').length, 1, 'legacy path omitted');
      assert(!root.querySelector('Рассказы'), 'path cannot become markup');
      assert([...root.querySelectorAll('details')].every((details) => !details.open), 'technical details collapsed');
      assert(links.every((link) => link.nextElementSibling.tagName === 'DETAILS'), 'Drive before details');
      root.querySelector('[data-error-toggle]').click();
      assert(links.every((link) => link.getBoundingClientRect().height >= 44), 'touch targets at least 44px');
      assert(formatIndexingErrors([entry('AAA', 'binary_file', { path })]).includes(`Path: ${path}`), 'export preserves path');
    } finally { window.fetch = originalFetch; controller.reset(); root.remove(); }
  });

  await test('dynamic filters count only current failed files, retain selection and never mutate records', () => {
    const { root, controller } = fixture();
    const entries = Object.entries({ binary_file: 76, not_xml_html: 33, invalid_xml: 13, not_xml_rtf: 3, new_code: 1 })
      .flatMap(([code, count]) => Array.from({ length: count }, (_, i) => entry(`${code}-${i}`, code)));
    entries.push(entry('warning', 'metadata_only_recovered', { outcome: 'recovered' }), entry('removed'),
      entry('removed', 'no_longer_eligible', { outcome: 'excluded' }));
    const snapshot = JSON.stringify(entries);
    controller.update(entries);
    const filter = root.querySelector('[data-error-filter]');
    equal([...filter.options].map((option) => option.textContent), ['Все ошибки (126)', 'binary_file (76)', 'invalid_xml (13)', 'new_code (1)', 'not_xml_html (33)', 'not_xml_rtf (3)'], 'actual codes and active counts');
    for (const [code, count] of [['binary_file', 76], ['not_xml_html', 33], ['', 126]]) {
      filter.value = code; filter.dispatchEvent(new Event('change'));
      equal(root.querySelector('[data-error-list]').children.length, count, 'filtered rows');
    }
    filter.value = 'binary_file'; filter.dispatchEvent(new Event('change'));
    controller.update(entries);
    equal(filter.value, 'binary_file', 'selection survives live update');
    equal(JSON.stringify(entries), snapshot, 'display only');
    equal(root.querySelector('[data-recovered-list]').children.length, 1, 'recovery remains separate');
    controller.update([entry('other', 'invalid_xml')]);
    equal(filter.value, '', 'missing selection returns to all');
    controller.reset(); root.remove();
  });

  await test('traversal supplies path to errors without per-file lookups and refresh removes deleted failures', async () => {
    const calls = [];
    const folder = (id, name) => ({ id, name, mimeType: 'application/vnd.google-apps.folder' });
    const children = { root: [folder('author', 'Чехов')], author: [folder('stories', 'Рассказы')],
      stories: [{ id: 'broken', name: 'book.fb2' }] };
    const index = await scanLibrary('root', () => {}, { getRoot: async () => folder('root', 'Books'),
      listChildren: async (id) => { calls.push(id); return children[id]; } });
    const recorded = recordIndexingError(index, index.books[0], [{ code: 'binary_file', stage: 'parse', retryResult: 'not-retried' }]);
    equal(recorded.path, 'Books / Чехов / Рассказы / book.fb2', 'path from normal traversal');
    equal(calls, ['root', 'author', 'stories'], 'only ordinary folder listing');
    equal(preserveBookMetadata({ ...index, books: [] }, index).indexingErrors, [], 'refresh removes deleted file from active log');
    const building = prepareBuildingIndex(index, { mode: 'retry' });
    await indexPendingBooks(building, { checkEligibility: createRetryEligibilityCheck(building, {
      getFile: async () => { throw Object.assign(new Error('Removed'), { status: 404 }); },
    }), extract: async () => { throw new Error('Deleted book must not download'); } });
    const completed = validateCompletedIndex(building, index);
    equal([completed.books.length, failedBookIds(completed).size], [0, 0], 'retry removal is no longer failed');
  });
}
