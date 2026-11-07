import { INVITATION_MAILER_URL } from './config.js';

const RESULT_TYPE = 'secret-library-invite-result';
const RESPONSE_TIMEOUT_MS = 60000;

function submitMailerPayload(payload, returnData = false) {
  const requestId = crypto.randomUUID();
  const frameName = `secret-library-mailer-${requestId}`;
  const frame = document.createElement('iframe');
  frame.name = frameName;
  frame.title = 'Сервис приглашений';
  frame.hidden = true;

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = INVITATION_MAILER_URL;
  form.target = frameName;
  form.hidden = true;

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify({ ...payload, requestId });
  form.append(input);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      form.remove();
      frame.remove();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      if (event.origin !== 'https://script.google.com' && event.origin !== 'https://script.googleusercontent.com') return;
      const data = event.data;
      if (!data || data.type !== RESULT_TYPE || data.requestId !== requestId) return;
      if (data.ok === true) finish(null, returnData ? (data.data || {}) : String(data.message || 'Приглашение отправлено.'));
      else finish(new Error(String(data.message || 'Не удалось выполнить операцию с приглашением.')));
    };
    const timer = setTimeout(() => {
      finish(new Error('Сервис не подтвердил операцию. Проверьте подключение и повторите попытку.'));
    }, RESPONSE_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    document.body.append(frame, form);
    form.submit();
  });
}

function validateMailerRequest(idToken) {
  if (!INVITATION_MAILER_URL || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(INVITATION_MAILER_URL)) {
    throw new Error('Сервис отправки писем ещё не настроен.');
  }
  if (typeof idToken !== 'string' || !idToken) {
    throw new Error('Не удалось подтвердить Google-сеанс. Повторите вход.');
  }
}

export function sendInvitationEmail({ email, idToken }) {
  try { validateMailerRequest(idToken); }
  catch (error) { return Promise.reject(error); }
  return submitMailerPayload({ email, idToken });
}

export function getInvitationStatuses({ emails, idToken }) {
  try { validateMailerRequest(idToken); }
  catch (error) { return Promise.reject(error); }
  if (!Array.isArray(emails) || !emails.length) return Promise.resolve({});
  return submitMailerPayload({ action: 'getInvitationStatuses', emails, idToken }, true);
}

export function acceptInvitation({ token, idToken }) {
  try { validateMailerRequest(idToken); }
  catch (error) { return Promise.reject(error); }
  if (typeof token !== 'string' || !/^[a-f0-9-]{32,100}$/i.test(token)) {
    return Promise.reject(new Error('Ссылка приглашения недействительна. Попросите отправить приглашение ещё раз.'));
  }
  return submitMailerPayload({ action: 'acceptInvitation', token, idToken }, true);
}
