// Clipboard write helper shared by the guided sharing flows. The synchronous
// legacy path runs first: it completes inside the click gesture while the
// document still has focus, before the Drive tab that the same click opens
// can take focus and fail every clipboard write with "Document is not
// focused".
export async function copyTextToClipboard(text) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (copied) return true;
  } catch { /* fall through to the async clipboard API */ }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { return false; }
  return false;
}
