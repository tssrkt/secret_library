# Социальный слой v1

## Подключение проекта

1. Создайте/выберите Firebase-проект в том же Google Cloud проекте, что и существующий Web OAuth client. Включите Google provider в Firebase Authentication и добавьте домен сайта в Authorized domains. Если используется отдельный OAuth client, настройте Google provider для существующего клиента; второй popup в приложении не используется.
2. Создайте Cloud Firestore (Native mode) и добавьте Web app. Внесите публичные `apiKey`, `authDomain`, `projectId`, `appId` в `js/firebase-config.js`. Пустой config намеренно не включает фиктивное соединение.
3. Установите зависимости `npm ci`. После проверки целевого проекта опубликуйте правила и индекс: `npx firebase deploy --only firestore:rules,firestore:indexes --project YOUR_PROJECT_ID`. В этой задаче публикация в реальный проект не выполнялась.
4. Выполните обычный Google-вход на сайте. При включённом Firebase config тот же GIS-вход запрашивает identity scopes `openid email profile` наряду с неизменёнными Drive scopes. Ранее сохранённая сессия, созданная до подключения identity scopes, может потребовать обычного повторного входа.

`GoogleAuthProvider.credential(null, googleAccessToken)` и `signInWithCredential` устанавливают Firebase-сеанс того же аккаунта без Firebase popup. Firebase Auth использует `inMemoryPersistence`, Firestore — стандартный кеш в памяти. Google access token не пишется в Firestore/localStorage. При выходе прекращаются подписки и Firebase-сеанс. Документация: [Google credentials](https://firebase.google.com/docs/reference/js/auth.googleauthprovider), [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin).

## Данные

| Путь | Содержимое и доступ |
| --- | --- |
| `users/{uid}` | Только displayName, photoURL, createdAt, invitedByUid; точечное чтение подтверждёнными Google-пользователями, изменение имени/аватара только владельцем |
| `userDirectory/{trimLowercaseEmail}` | Только uid; точечный get, list запрещён; создать можно только для своего verified Google email |
| `libraryShares/{ownerUid}__{viewerUid}` | ownerUid, viewerUid, active, sharedAt, revokedAt; читать могут участники; активирует/отзывает владелец |
| `pendingInvites/{email}` | Приватный служебный указатель первого приглашения: firstOwnerUid, createdAt; создаётся атомарно с первым pending и больше не изменяется; list запрещён |
| `pendingInvites/{email}/shares/{ownerUid}` | ownerUid, inviteeEmail, active, createdAt, claimedUid, claimedAt; доступ владельцу и подтверждённому адресату; collection-group query только с ownerUid текущего пользователя |
| `users/{uid}/knownContacts/{otherUid}` | Email, который владелец сам вводил; чтение/запись только владельцем, запись проверяется по directory |
| `users/{uid}/incomingShareReads/{ownerUid}` | seenSharedAt; только получатель, timestamp проверяется по реальному входящему share |

Индекс, FB2, книги, обложки и настройки excludedFolderIds остаются в Google Drive. Share не копирует выбор папок: он обозначает доступ ко всем папкам, разрешённым общей настройкой владельца. Применение этого доступа к чужой библиотеке — следующий этап; сейчас Drive permissions не меняются.

## Транзакции и приглашения

Повтор активного share не меняет sharedAt. Отзыв выключает только исходящее направление. Новая активация записывает новый serverTimestamp и создаёт новое непрочитанное событие. Pending email не появляется среди друзей.

При регистрации профиль и directory создаются транзакцией. Неизменяемый указатель первого pending определяет самого раннего inviter; конкурентные приглашения сериализуются на этом документе. Самостоятельная регистрация фиксирует invitedByUid=null. Поле нельзя переписать позже. Отзыв pending-приглашений не входит в v1; pending сохраняется как выданное разрешение до claim.

Затем читаются pending только для собственного verified email. Каждое принятие — транзакция из share и claimedUid/claimedAt. Это узкое исключение из owner-only записи share: rules проверяют неиспользованное разрешение owner и обе записи через get/getAfter. Получатель не может произвольно создать входящий share или повторить claim после отзыва. При повторном входе процесс возобновляется без дублей. При открытии настроек inviter восстанавливает knownContacts из собственных принятых pending.

Почта не отправляется. «Приглашение сохранено» означает только сохранённое pending-разрешение.

## Интерфейс и уведомления

Две подписки на связи (owner/viewer) и две приватные подписки (knownContacts/read markers) обновляют интерфейс. Публичные имена загружаются по uid, email из профилей не используется. Друзья объединяются по uid, сортируются по имени и uid, затем общий paginator выбирает максимум 50 строк для DOM. Переход страницы не читает Firestore повторно.

Уведомления выводятся из активных входящих shares; отдельной коллекции событий нет. Badge считает sharedAt новее seenSharedAt. Dropdown показывает последние 50; при открытии только они помечаются просмотренными, пакетами по 10 для соблюдения лимитов доступа rules. «ПОДЕЛИТЬСЯ В ОТВЕТ» вызывает ту же транзакцию исходящего share. Кнопки операций блокируются по месту, ошибки сохраняют форму и позволяют повтор.

## Граница приватности

Rules запрещают list Gmail-каталога и чтение чужих private subcollections. Разрешённый точечный lookup неизбежно подтверждает существование введённого адреса. **Firestore Rules не могут ограничить частоту последовательного угадывания отдельных адресов**. Поэтому list закрыт, но полной защиты от перебора через множество разрешённых get в клиентской архитектуре нет. Для такой гарантии нужен серверный rate-limited lookup/anti-abuse слой, запрещённый рамками текущего ТЗ. Это ограничение нельзя скрыть UI-проверкой. Подробности [правил и запросов](https://firebase.google.com/docs/firestore/security/rules-query).

## Проверки

Java 21+ и Node 22+ нужны только разработчику для эмулятора. `npm run test:social` запускает правила на локальном demo-проекте (порт 18087), без реальных пользователей или Drive. `node tests/search-keyboard.mjs` проверяет браузерные сценарии, включая социальные модели, таблицу, уведомления и существующие режимы.

После подключения реального проекта отдельно проверить вход двух Google-аккаунтов, разрешённый домен и публикацию правил/индекса. Без Web config живое межпользовательское соединение не настроено.
