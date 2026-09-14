export function createLibraryTabs(root, onSelect) {
  const button = (label, text) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
    node.setAttribute('aria-label', label); node.title = label; node.hidden = true; return node;
  };
  const previous = button('Прокрутить библиотеки влево', '←');
  const next = button('Прокрутить библиотеки вправо', '→');
  const expand = button('Показать все', '⌄');
  const strip = document.createElement('div');
  strip.className = 'library-tab-strip'; strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Библиотеки');
  root.replaceChildren(previous, strip, next, expand);
  let expanded = false;
  let active = '';
  let frame = 0;
  let revealFrames = 0;
  let drag = null;
  let suppressClick = false;
  const reveal = () => {
    if (expanded) return;
    const node = [...strip.children].find((tab) => tab.dataset.library === active);
    if (!node) return;
    const rect = node.getBoundingClientRect(); const bounds = strip.getBoundingClientRect();
    if (rect.left < bounds.left) strip.scrollLeft -= bounds.left - rect.left;
    else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right;
  };
  const layout = () => {
    frame = 0;
    if (!root.clientWidth) return;
    const naturalWidth = [...strip.children].reduce((sum, node) => sum + node.getBoundingClientRect().width, 0)
      + Math.max(0, strip.children.length - 1) * (parseFloat(getComputedStyle(strip).columnGap) || 0);
    if (naturalWidth <= root.clientWidth + 1) {
      expanded = false; root.classList.remove('expanded');
      expand.textContent = '⌄'; expand.title = 'Показать все'; expand.setAttribute('aria-label', expand.title); expand.setAttribute('aria-expanded', 'false');
      previous.hidden = next.hidden = expand.hidden = true; return;
    }
    if (expanded) { previous.hidden = next.hidden = true; expand.hidden = false; return; }
    previous.hidden = strip.scrollLeft <= 1;
    next.hidden = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    const bounds = strip.getBoundingClientRect();
    const hiddenCount = [...strip.children].filter((node) => {
      const rect = node.getBoundingClientRect(); return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
    }).length;
    expand.hidden = hiddenCount < 5;
    if (revealFrames > 0) { revealFrames--; reveal(); schedule(); }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(layout); };
  strip.addEventListener('scroll', schedule, { passive: true });
  previous.addEventListener('click', () => strip.scrollBy({ left: -strip.clientWidth * .75, behavior: 'smooth' }));
  next.addEventListener('click', () => strip.scrollBy({ left: strip.clientWidth * .75, behavior: 'smooth' }));
  expand.addEventListener('click', () => {
    expanded = !expanded;
    root.classList.toggle('expanded', expanded);
    expand.textContent = expanded ? '⌃' : '⌄';
    expand.title = expanded ? 'Свернуть' : 'Показать все';
    expand.setAttribute('aria-label', expand.title); expand.setAttribute('aria-expanded', String(expanded));
    revealFrames = 3; layout(); reveal(); schedule();
  });
  strip.addEventListener('pointerdown', (event) => {
    if (expanded || event.pointerType !== 'mouse' || event.button !== 0) return;
    suppressClick = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: strip.scrollLeft, moved: false };
  });
  strip.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const delta = event.clientX - drag.x;
    if (!drag.moved && Math.abs(delta) > 6 && Math.abs(delta) > Math.abs(event.clientY - drag.y)) {
      drag.moved = true; strip.setPointerCapture(event.pointerId); strip.classList.add('dragging');
    }
    if (drag.moved) { event.preventDefault(); strip.scrollLeft = drag.scroll - delta; }
  });
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = drag.moved;
    if (strip.hasPointerCapture(event.pointerId)) strip.releasePointerCapture(event.pointerId);
    drag = null; strip.classList.remove('dragging');
  };
  strip.addEventListener('pointerup', finish);
  strip.addEventListener('pointercancel', finish);
  strip.addEventListener('pointerleave', () => { if (drag && !drag.moved) drag = null; });
  strip.addEventListener('lostpointercapture', finish);
  strip.addEventListener('click', (event) => {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, true);
  strip.addEventListener('keydown', (event) => {
    const tabs = [...strip.children]; const position = tabs.indexOf(document.activeElement);
    if (position < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (position + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[target].focus({ preventScroll: true }); tabs[target].click();
  });
  const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(strip);
  return {
    update(libraries, selected = '') {
      active = selected;
      const values = [{ uid: '', displayName: 'Моя библиотека' }, ...libraries];
      const signature = JSON.stringify(values.map(({ uid, displayName }) => [uid, displayName]));
      if (strip.dataset.signature !== signature) {
        strip.dataset.signature = signature;
        strip.replaceChildren(...values.map((library) => {
          const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'library-tab';
          tab.textContent = library.displayName; tab.dataset.library = library.uid;
          tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'library-tree');
          tab.addEventListener('click', () => onSelect(library.uid)); return tab;
        }));
      }
      for (const tab of strip.children) {
        tab.setAttribute('aria-selected', String(tab.dataset.library === active));
        tab.tabIndex = tab.dataset.library === active || (!values.some((value) => value.uid === active) && !tab.dataset.library) ? 0 : -1;
      }
      revealFrames = 3; layout(); reveal(); schedule();
    },
    destroy() { observer.disconnect(); cancelAnimationFrame(frame); root.replaceChildren(); },
  };
}
