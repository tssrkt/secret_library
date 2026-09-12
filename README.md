# Тайная библиотека

Полностью клиентское веб-приложение для отображения и индексации FB2-библиотеки из выбранной папки Google Drive. Текущий статус — **Stage 1**: приложение работает только с файловыми метаданными и не скачивает содержимое книг.

## Архитектура

- `index.html`, `css/styles.css` — статический интерфейс;
- `js/auth.js` — Google Identity Services и access token только в памяти вкладки;
- `js/drive.js` — минимальный клиент Google Drive API v3, пагинация и ограниченные retry;
- `js/library-tree.js` — рекурсивный обход папок с concurrency 4 и построение плоского индекса;
- `js/library-index.js` — чтение и запись индекса в `appDataFolder`;
- `js/ui.js` — лениво раскрываемое дерево;
- `js/app.js` — сценарии первого и повторного запуска;
- `js/config.js` — Client ID и ID корневой папки.

Индекс `secret-library-index.json` имеет версию 1 и поля `rootFolderId`, `createdAt`, `updatedAt`, плоские массивы `folders[]` и `books[]`. Он хранится в скрытом пространстве `appDataFolder` Google Drive самого пользователя. Это служебное пространство доступно только приложению и не является частью репозитория.

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

## Границы Stage 1

Книгами считаются только файлы с расширением `.fb2` без учета регистра. Приложение не загружает FB2, не разбирает XML, не извлекает книжные метаданные и не реализует поиск, читалку, offline/PWA или Changes API.
