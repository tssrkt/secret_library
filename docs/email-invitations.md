# Почтовые приглашения

Приглашения отправляются через бесплатный Google Apps Script от имени Google-аккаунта владельца скрипта. Для этого не используются Firebase Cloud Functions, SMTP, Secret Manager или платный тариф Firebase.

## Настройка

Инструкция и исходный код находятся в `apps-script-invite/`.

Кратко:
1. Создайте проект на https://script.google.com/ под аккаунтом, от которого должны уходить письма.
2. Перенесите `apps-script-invite/Code.gs` и `apps-script-invite/appsscript.json` в проект Apps Script.
3. Запустите `authorizeMailer` один раз и подтвердите разрешения Google.
4. Разверните как Web app: Execute as **Me**, доступ **Anyone**.
5. Скопируйте URL `/exec` в `INVITATION_MAILER_URL` файла `js/config.js`.
6. Опубликуйте обновлённый сайт.

Apps Script проверяет Firebase ID-токен через Firebase Authentication, а затем читает профиль и приглашение через Firestore REST API с пользовательским токеном. Firestore применяет действующие Security Rules. Изменения правил и деплой Firebase для перехода не требуются.

Для личного Gmail действует квота Google Apps Script MailApp — 100 получателей в сутки на аккаунт владельца скрипта. Дополнительно сервис ограничивает каждого пользователя 10 приглашениями за 24 часа. Квоты Google могут изменяться.

Старую callable Cloud Function `inviteToLibrary` оставляем как неиспользуемую legacy-функцию. Браузер больше не вызывает её. Удалять или развёртывать Cloud Function для работы бесплатной рассылки не нужно.
