# Тайная библиотека

Полностью клиентское веб-приложение для отображения и индексации FB2-библиотеки из выбранной папки Google Drive. Текущий статус — **Stage 2**: приложение извлекает текстовые метаданные FB2 непосредственно в браузере, не скачивая библиотеку целиком.

## Архитектура

- `index.html`, `css/styles.css` — статический интерфейс;
- `js/auth.js` — Google Identity Services и access token только в памяти вкладки;
- `js/drive.js` — минимальный клиент Google Drive API v3, пагинация и ограниченные retry;
- `js/library-tree.js` — рекурсивный обход папок с concurrency 4 и построение плоского индекса;
- `js/library-index.js` — чтение и запись индекса в `appDataFolder`;
- `js/fb2.js` — последовательное partial-чтение и XML-разбор `<description>`;
- `js/metadata-indexer.js` — batch-обработка с concurrency 3, отменой и checkpoints;
- `js/ui.js` — лениво раскрываемое дерево;
- `js/app.js` — сценарии первого и повторного запуска;
- `js/config.js` — Client ID и ID корневой папки.

Индекс `secret-library-index.json` имеет версию 2 и поля `rootFolderId`, `createdAt`, `updatedAt`, плоские массивы `folders[]` и `books[]`. Индекс Stage 1 версии 1 автоматически мигрирует: отсутствующие метаданные получают статус `pending`. Он хранится в скрытом пространстве `appDataFolder` Google Drive самого пользователя. Это служебное пространство доступно только приложению и не является частью репозитория.

## Метаданные FB2

По явной команде «Проиндексировать книги» приложение извлекает из `<description>/<title-info>` название, массив авторов, первую серию и номер, а также текст аннотации. Сначала запрашиваются только байты `0-65535` через HTTP `Range`. Если `</description>` не найден, последовательно дочитываются `65536-262143` и `262144-1048575` без повторной загрузки предыдущих байтов. Обычный верхний предел — 1 MiB на книгу; если сервер неожиданно ответит `200 OK` вместо `206 Partial Content`, используется уже присланный полный ответ без дополнительных запросов.

Поддерживаются UTF-8, windows-1251 и UTF-16 с учетом BOM и XML declaration. Возможные коды ошибок отдельной книги: `invalid_xml`, `unsupported_encoding`, `description_not_found`, `download_failed`, `parse_failed`. Ошибка одной книги не останавливает batch.

Результат сохраняется в `appDataFolder` каждые 50 обработанных книг и в конце. После остановки незавершенные записи снова становятся `pending`, поэтому следующий запуск продолжает работу. Записи `ready` повторно не обрабатываются. «Повторить ошибки» — отдельное явное действие.

При «Обновить библиотеку» метаданные переносятся по Drive file ID, если совпадает `md5Checksum`, а при его отсутствии — `modifiedTime` и `size`. Новые и измененные FB2 получают статус `pending`.

## Настройка Google Cloud

1. Создайте или выберите проект в Google Cloud Console.
2. Включите **Google Drive API**.
3. Настройте OAuth consent screen и добавьте scopes:
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/drive.appdata`
4. Создайте OAuth Client ID типа **Web application**.
5. Добавьте authorized JavaScript origins:
   - `http://localhost:8000`
   - `https://tssrkt.github.io`
6. Вставьте полученный Client ID вместо placeholder в `js/config.js`.

Для браузерного приложения Client ID публичен. **Client secret, refresh token и другие секреты нельзя добавлять во frontend или репозиторий.** Если consent screen находится в режиме Testing, добавьте нужные Google-аккаунты как test users. Папка с ID из `js/config.js` должна быть доступна вошедшему пользователю.

## Локальный запуск

Из корня проекта запустите уже доступный Python:

```bash
python -m http.server 8000
```

Откройте `http://localhost:8000/`. Запуск через `file://` не поддерживается. Для GitHub Pages публикуйте репозиторий из ветки `main`; относительные пути совместимы с `https://tssrkt.github.io/secret_library/`.

## Границы Stage 2

Книгами считаются только файлы с расширением `.fb2` без учета регистра. Обложки не извлекаются: `<binary>` может находиться далеко от начала FB2 и потребовать полного скачивания. Приложение также не реализует поиск, читалку, offline/PWA или Changes API.

Локальные браузерные тесты находятся в `tests/fb2-tests.html`; при запущенном HTTP-сервере откройте `http://localhost:8000/tests/fb2-tests.html`.
