import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, 'invitation-template.json'), 'utf8'));

export function invitationMail(displayName) {
  return { subject: template.subject, text: template.text.replaceAll('{{имя_пригласившего}}', displayName) };
}
