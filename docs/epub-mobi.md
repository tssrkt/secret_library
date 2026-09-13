# EPUB и MOBI

Четыре `sourceType`: `fb2`, `zip`, `epub`, `mobi`. Расширение проверяется раньше
MIME ZIP. Дополнительно распознаются `application/epub+zip` и
`application/x-mobipocket-ebook`. AZW/AZW3 и остальные исключённые форматы не добавлены.
`INDEX_VERSION = 4` и `METADATA_VERSION = 2` не меняются.

После «Обновить библиотеку» scan обнаруживает новые форматы. Неизменённые книги
сохраняют metadata, новые/изменённые — pending. После сохранения scan приложение
обрабатывает только pending/processing в отдельном shadow build. Готовые старые
книги не перечитываются. Полная переиндексация и retry ошибок остаются отдельными
действиями; они поддерживают все четыре формата.

## EPUB

`openZip()` в `zip.js` предоставляет общий каталог и чтение отдельной записи.
EPUB не имеет второго ZIP-парсера и не распаковывается целиком. Используются
существующие EOCD/central-directory/Range cache/Store/Deflate и проверки бюджетов.

`META-INF/container.xml` задаёт путь к package document. OPF читается строго как
XML, поддерживает namespaces и относительные/percent-encoded пути. Внешние URL
и выход за корень архива не загружаются. Из DC извлекаются title, отдельные creator
(роль aut или без роли), language, description, subject. Темы остаются исходными
строками. Поддержаны calibre series/index и EPUB3 belongs-to-collection,
collection-type=series, group-position. Без номера возвращается null.

Обложки: EPUB3 `cover-image` либо EPUB2 `meta name=cover` с manifest id. Изображение
проверяется по сигнатуре и browser decoder, затем поступает в общий cover cache.
Отсутствие/неподдерживаемая или повреждённая картинка не уничтожает metadata.

Без annotation просматриваются до пяти подходящих документов spine. Nav, nonlinear
и очевидные cover/toc/titlepage/copyright ресурсы пропускаются. Возвращаются обычные
абзацы до 1200 символов, целевой размер около 800. HTML разбирается в inert template,
без выполнения JS, загрузки ресурсов или вставки содержимого книги в страницу.

Отдельные budgets: container 256 KiB, OPF 2 MiB, один preview document 512 KiB,
cover 8 MiB. Шрифты и другие ресурсы не читаются. SVG-обложки не поддержаны.

## MOBI

Читаются PDB header/directory и record 0, затем только необходимые image/text
records. Проверяются BOOK/MOBI identity, размеры, offsets и EXTH record boundaries.
Header/record 0 ограничен 2 MiB. Поддержаны UTF-8 и браузерные Windows codepages.

Фактически извлекаются EXTH 503 (title, затем MOBI full name), 100 (authors),
103 (description), 105 (subjects), 524 (language). При отсутствии 524 используется
таблица распространённых primary LCID; неизвестный язык остаётся null.
В переносимых EXTH metadata нет надёжного общего поля серии: series/seriesNumber
остаются null; имя файла и title для угадывания серии не используются.

Cover определяется только через EXTH 201 + first image record, максимум 8 MiB,
и проходит ту же проверку изображения. Preview — первые максимум восемь text
records, суммарно до 512 KiB, только uncompressed/PalmDOC. HUFF/CDIC, KF8 text,
records с extra-data flags и encrypted text пропускаются без ошибки metadata.
DRM не обходится. EXTH/title остаются доступными независимо от text compression.
Повреждённый заголовок/каталог вызывает контролируемую ошибку конкретной книги.

Для всех форматов abort возвращает processing-книгу в pending. Ошибка 416 вызывает
одну полную повторную загрузку с последующим локальным чтением ranges. Настоящие
сетевые ошибки не выдаются за отсутствие optional resource.

## Общая модель и проверка

В индекс попадают только поля существующей модели metadata; manifest/spine,
record directory, EXTH, HTML и распакованный контент не сохраняются. Только cover
проходит в существующий appData cache. Карточки, поиск, direct-filter, пагинация,
аннотация и скачивание используют прежние компоненты. Filename/fileId исходного
EPUB/MOBI сохраняются для «СКАЧАТЬ». OAuth scopes и Firestore не меняются.

Синтетические fixtures проверяют оба варианта EPUB cover/series, preview, EXTH,
PalmDOC, DRM, 416, abort, повреждённые ресурсы и selective refresh с 9257 готовыми
FB2/ZIP. PNG — сгенерированный пиксель; реальных коммерческих книг в fixtures нет.

Использованные спецификации (без копирования кода/dependencies):

- [W3C EPUB 3.3](https://www.w3.org/TR/epub-33/)
- [Описание MOBI в репозитории calibre](https://github.com/kovidgoyal/calibre/blob/master/format_docs/pdb/mobi.txt)
- [Разбор EXTH в calibre](https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/mobi/reader/headers.py)
