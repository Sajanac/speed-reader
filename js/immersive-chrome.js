// Presentation only: never changes the document, reading index or saved prefs.
export function createImmersiveChrome({ reader, onExit, idleMs = 3000 }) {
  const body = document.body;
  const chrome = [...document.querySelectorAll('.topbar, .reading-toolbar, .controls, .status, .selection-toolbar')];
  let active = false, playing = false, timer, held = false, hovered = false, previousFocus;
  const inside = (node) => chrome.some((part) => part.contains(node));
  const busy = () => held || hovered || inside(document.activeElement)
    || document.querySelector('dialog[open]') || !window.getSelection()?.isCollapsed;
  function visible(show) {
    body.classList.toggle('immersive-controls-visible', show);
    for (const part of chrome) part.inert = active && !show;
  }
  function schedule() {
    clearTimeout(timer);
    if (active && playing) timer = setTimeout(() => {
      if (busy()) schedule(); else visible(false);
    }, idleMs);
  }
  function reveal() { if (active) { visible(true); schedule(); } }
  function leave() {
    if (!active) return;
    onExit();
    active = false; clearTimeout(timer);
    body.classList.remove('immersive-focus', 'immersive-controls-visible');
    for (const part of chrome) part.inert = false;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  for (const part of chrome) {
    part.addEventListener('focusin', reveal);
    part.addEventListener('focusout', schedule);
    part.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') { hovered = true; reveal(); } });
    part.addEventListener('pointerleave', () => { hovered = false; schedule(); });
    part.addEventListener('pointerdown', () => { held = true; reveal(); });
    part.addEventListener('input', reveal);
  }
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { held = false; schedule(); });
  document.addEventListener('click', (event) => {
    if (!active || !reader.contains(event.target) || !window.getSelection()?.isCollapsed) return;
    // The first tap reveals controls without also jumping to a different word.
    if (!body.classList.contains('immersive-controls-visible')) event.stopImmediatePropagation();
    reveal();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!active || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); leave(); }
    else if (event.key === 'Tab') reveal();
  }, true);
  document.addEventListener('selectionchange', () => { if (active && !window.getSelection()?.isCollapsed) reveal(); });
  document.querySelector('#btn-exit-immersive').addEventListener('click', leave);
  return {
    leave,
    sync(mode, isPlaying) {
      playing = isPlaying;
      if (mode !== 'immersive') {
        active = false; clearTimeout(timer); body.classList.remove('immersive-focus', 'immersive-controls-visible');
        for (const part of chrome) part.inert = false;
        return;
      }
      if (playing && !active) {
        active = true; previousFocus = document.activeElement;
        body.classList.add('immersive-focus');
        document.querySelector('#toast')?.classList.remove('show');
        reader.focus({ preventScroll: true });
        visible(false);
      } else if (active && !playing) reveal();
      else if (active) schedule();
    },
  };
}
