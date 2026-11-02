import { INVITATION_MAILER_URL } from './config.js';

const RESULT_TYPE = 'secret-library-invite-result';
const RESPONSE_TIMEOUT_MS = 60000;

export function sendInvitationEmail({ email, idToken }) {
  if (!INVITATION_MAILER_URL || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(INVITATION_MAILER_URL)) {
    return Promise.reject(new Error('Сервис отправки писем ещё не настроен.'));
  }
  if (typeof idToken !== 'string' || !idToken) {
    return Promise.reject(new Error('Не удалось подтвердить Google-сеанс. Повторите вход.'));
  }

  const requestId = crypto.randomUUID();
  const frameName = `secret-library-mailer-${requestId}`;
  const frame = document.createElement('iframe');
  frame.name = frameName;
  frame.title = 'Отправка приглашения';
  frame.hidden = true;

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = INVITATION_MAILER_URL;
  form.target = frameName;
  form.hidden = true;

  const payload = document.createElement('input');
  payload.type = 'hidden';
  payload.name = 'payload';
  payload.value = JSON.stringify({ requestId, email, idToken });
  form.append(payload);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      form.remove();
      frame.remove();
    };
    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(message);
    };
    const onMessage = (event) => {
      if (event.origin !== 'https://script.google.com' &&
          !event.origin.endsWith('.googleusercontent.com')) return;
      const data = event.data;
      if (!data || data.type !== RESULT_TYPE || data.requestId !== requestId) return;
      if (data.ok === true) finish(null, String(data.message || 'Приглашение отправлено.'));
      else finish(new Error(String(data.message || 'Не удалось отправить приглашение.')));
    };
    const timer = setTimeout(() => {
      finish(new Error('Сервис не подтвердил отправку письма. Проверьте почту перед повторной попыткой.'));
    }, RESPONSE_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    document.body.append(frame, form);
    form.submit();
  });
}
