# Почтовые приглашения

Приглашения отправляет callable Cloud Function `inviteToLibrary` в существующем Firebase-проекте `project-071ee00e-4a4a-4a3d-95d`. Браузер не получает SMTP-реквизиты и не может записать статус `emailStatus`.

Однократная настройка владельца:

1. Установите Firebase CLI и войдите в нужный аккаунт: `npm install -g firebase-tools`, затем `firebase login`.
2. Установите серверные зависимости: `npm --prefix functions ci`.
3. Задайте секреты (значения приводятся только в интерактивном вводе):

   ```bash
   firebase functions:secrets:set SMTP_HOST --project project-071ee00e-4a4a-4a3d-95d
   firebase functions:secrets:set SMTP_PORT --project project-071ee00e-4a4a-4a3d-95d
   firebase functions:secrets:set SMTP_USER --project project-071ee00e-4a4a-4a3d-95d
   firebase functions:secrets:set SMTP_PASSWORD --project project-071ee00e-4a4a-4a3d-95d
   firebase functions:secrets:set SMTP_FROM --project project-071ee00e-4a4a-4a3d-95d
   ```

4. Разверните правила и функцию: `firebase deploy --only firestore:rules,functions --project project-071ee00e-4a4a-4a3d-95d`.

Для `SMTP_PORT` укажите номер порта SMTP. Порт `465` используется с TLS; остальные поддерживаемые SMTP-порты подключаются через STARTTLS, если это настроено поставщиком. Реальные пароли, ключи и токены не записывайте в репозиторий.

Шаблон письма генерируется из `temp/email.docx` в `functions/invitation-template.json`. После изменения исходных DOCX выполните `python scripts/build-public-documents.py`; проверка актуальности: `python scripts/build-public-documents.py --check`.
