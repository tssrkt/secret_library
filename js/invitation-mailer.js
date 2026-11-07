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
      // Apps Script HTMLService runs the response in a Google-controlled nested
      // iframe, so event.source is not necessarily the outer form-target iframe.
      // The allowlisted Google origin plus this one-time, unguessable requestId
      // binds the response to this request without rejecting the legitimate reply.
      if (!/^https:\/\/(?:script\.google\.com|script\.googleusercontent\.com|[a-z0-9-]+-script\.googleusercontent\.com)$/.test(event.origin)) return;
      const data = event.data;
      if (!data || data.requestId !== requestId) return;
      if (data.type === 'secret-library-admin-result') {
        finish(new Error(String(data.message || 'Сервис приглашений не поддерживает эту операцию. Обновите развёртывание Apps Script до последней версии.')));
        return;
      }
      if (data.type !== RESULT_TYPE) return;
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

export function cancelInvitation({ email, idToken }) {
  try { validateMailerRequest(idToken); }
  catch (error) { return Promise.reject(error); }
  if (typeof email !== 'string' || !email.trim()) {
    return Promise.reject(new Error('Не указан адрес приглашённого участника.'));
  }
  return submitMailerPayload({ action: 'cancelInvitation', email: email.trim().toLowerCase(), idToken }, true);
}

export function getInvitationStatuses({ emails, idToken }) {
  try { validateMailerRequest(idToken); }
  catch (error) { return Promise.reject(error); }
  if (!Array.isArray(emails)) return Promise.reject(new Error('Invitation emails must be an array.'));
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
