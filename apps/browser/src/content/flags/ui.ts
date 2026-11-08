/** Injected UI for flags: a button per post and a placeholder for hidden posts (shadow DOM). */

export const BUTTON_TAG = 'potato-flag';
export const PLACEHOLDER_TAG = 'potato-flag-hidden';

const BUTTON_CSS = `
:host { all: initial; display: inline-flex; vertical-align: middle; margin: 0 4px; z-index: 1; position: relative; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  height: 24px; padding: 0 9px; border-radius: 999px; font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  color: #57534e; background: rgba(120, 113, 108, .12); border: 1px solid rgba(120, 113, 108, .25); white-space: nowrap;
  transition: background .15s, color .15s, border-color .15s;
}
button:hover { background: rgba(120, 113, 108, .2); color: #292524; }
button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
button[data-state="mine"] { background: #1c1917; color: #fafaf9; border-color: #1c1917; }
button[data-state="flagged"] { background: #fef3c7; color: #92400e; border-color: #f59e0b; }
button[data-state="busy"] { opacity: .6; cursor: progress; }
button[data-state="error"] { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
button[data-state="disputed"] { background: #ecfdf5; color: #065f46; border-color: #6ee7b7; }
button.dispute { margin-left: 4px; padding: 0 8px; font-weight: 500; }
button.dispute[hidden] { display: none; }
svg { width: 12px; height: 12px; flex: none; }
@media (prefers-color-scheme: dark) {
  button { color: #d6d3d1; background: rgba(214, 211, 209, .1); border-color: rgba(214, 211, 209, .22); }
  button:hover { color: #fafaf9; background: rgba(214, 211, 209, .18); }
  button[data-state="mine"] { background: #fafaf9; color: #1c1917; border-color: #fafaf9; }
  button[data-state="flagged"] { background: rgba(245, 158, 11, .18); color: #fcd34d; border-color: rgba(245, 158, 11, .5); }
  button[data-state="disputed"] { background: rgba(16, 185, 129, .16); color: #6ee7b7; border-color: rgba(16, 185, 129, .45); }
}
`;

const PLACEHOLDER_CSS = `
:host { all: initial; display: block; margin: 8px 0; }
div {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px;
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  color: #57534e; background: #f5f5f4; border: 1px dashed #d6d3d1;
}
span { flex: 1; }
button { all: unset; cursor: pointer; font-weight: 600; color: #1c1917; text-decoration: underline; text-underline-offset: 2px; }
button + button { margin-left: 10px; }
button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; border-radius: 4px; }
@media (prefers-color-scheme: dark) {
  div { color: #d6d3d1; background: #1c1917; border-color: #44403c; }
  button { color: #fafaf9; }
}
`;

/** Builds the flag icon with DOM APIs: some sites (YouTube) enforce Trusted Types, so no innerHTML. */
function flagIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M3.5 14V2.5', 'M3.5 2.8c3-1.6 5.2 1.6 9 0v6.4c-3.8 1.6-6-1.6-9 0']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function styleEl(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  return style;
}

export type ButtonState = 'idle' | 'mine' | 'flagged' | 'disputed' | 'busy' | 'error';

// Closed, so page scripts cannot read which posts the user flagged. The e2e suite needs open
// roots to reach the buttons and turns this on through PageConfig.testHooks.
let shadowMode: ShadowRootMode = 'closed';
export function setOpenShadowRoots(open: boolean): void {
  shadowMode = open ? 'open' : 'closed';
}

export interface FlagButton {
  host: HTMLElement;
  /** `n` is the net count (AI flags minus Not AI votes), `ai` and `human` the two sides. */
  set(state: ButtonState, n: number, threshold: number, votes?: { ai: number; human: number }): void;
}

function stopPropagation(host: HTMLElement, types: readonly string[]): void {
  // Keep clicks from reaching the post (which would open it on most sites).
  for (const type of types) host.addEventListener(type, (e) => e.stopPropagation());
}

/** Only the user's own clicks: a page script calling click() must not vote as the user. */
function onTrustedClick(button: HTMLButtonElement, fn: () => void): void {
  button.addEventListener('click', (e) => {
    e.preventDefault();
    if (e.isTrusted) fn();
  });
}

/** The AI? button, with a Not AI button beside it while the post counts as AI-generated. */
export function createButton(onMain: () => void, onDispute: () => void): FlagButton {
  const host = document.createElement(BUTTON_TAG);
  const root = host.attachShadow({ mode: shadowMode });
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.state = 'idle';
  const label = document.createElement('span');
  button.append(flagIcon(), label);
  const dispute = document.createElement('button');
  dispute.type = 'button';
  dispute.className = 'dispute';
  dispute.hidden = true;
  dispute.textContent = 'Not AI';
  dispute.title = 'Made by a person? Say so. Not AI votes cancel AI flags one for one.';
  dispute.setAttribute('aria-label', dispute.title);
  root.append(styleEl(BUTTON_CSS), button, dispute);
  stopPropagation(host, ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']);
  onTrustedClick(button, () => button.dataset.state !== 'busy' && onMain());
  onTrustedClick(dispute, () => button.dataset.state !== 'busy' && onDispute());
  return {
    host,
    set(state, n, threshold, votes) {
      button.dataset.state = state;
      const split = votes && votes.human > 0 ? ` ${votes.ai} flagged it, ${votes.human} said Not AI.` : '';
      if (state === 'mine') {
        label.textContent = n > 1 ? `Flagged as AI · ${n}` : 'Flagged as AI';
        button.title = `You called this one artificial.${split} Click to undo.`;
      } else if (state === 'flagged') {
        label.textContent = `AI · ${n}`;
        button.title = `Counts as AI-generated.${split || ` ${n} ${n === 1 ? 'person' : 'people'} flagged it.`} Click to add your flag.`;
      } else if (state === 'disputed') {
        label.textContent = 'You said Not AI';
        button.title = `You said a person made this.${split} Click to undo.`;
      } else if (state === 'busy') {
        label.textContent = 'Mashing...';
      } else if (state === 'error') {
        label.textContent = 'Offline, try again';
        button.title = 'Could not reach the flag service. Try again in a moment.';
      } else {
        label.textContent = n > 0 && n < threshold ? `AI? · ${n}` : 'AI?';
        button.title = 'Smells artificial? Flag it as AI-generated (anonymous)';
      }
      dispute.hidden = state !== 'flagged';
      button.setAttribute('aria-pressed', String(state === 'mine' || state === 'disputed'));
      button.setAttribute('aria-label', button.title);
    },
  };
}

export function createPlaceholder(n: number, mine: boolean, onShow: () => void, onDispute?: () => void): HTMLElement {
  const host = document.createElement(PLACEHOLDER_TAG);
  const root = host.attachShadow({ mode: shadowMode });
  const who = mine && n <= 1 ? 'you' : `${n} ${n === 1 ? 'person' : 'people'}`;
  const box = document.createElement('div');
  box.setAttribute('role', 'note');
  const text = document.createElement('span');
  text.textContent = `Buried: flagged as AI-generated by ${who}.`;
  const show = document.createElement('button');
  show.type = 'button';
  show.textContent = 'Show';
  box.append(flagIcon(), text, show);
  if (onDispute && !mine) {
    const dispute = document.createElement('button');
    dispute.type = 'button';
    dispute.textContent = 'Not AI';
    dispute.title = 'Made by a person? Say so, and it comes back for you.';
    onTrustedClick(dispute, onDispute);
    box.append(dispute);
  }
  root.append(styleEl(PLACEHOLDER_CSS), box);
  stopPropagation(host, ['click', 'mousedown', 'pointerdown']);
  onTrustedClick(show, onShow);
  return host;
}
