import { WebContentsView, type Rectangle, type WebContents } from 'electron';
import type { AutofillView } from '../../shared/types';
import { paths } from '../paths';
import type { BrowserWindowController } from '../window';

const MARGIN = 8;
const PAD = 6;
const ROW = 42;
// The footer button, its divider and the card border (see autofill.css).
const FOOT = 37;
const MAX_ROWS = 5;

/**
 * The saved-logins dropdown under a login field. It is a view of the browser, not part of the
 * page, so the page can neither read it nor click it for the user.
 */
export class AutofillPopup {
  private view: WebContentsView | null = null;
  private ready = false;
  private last: AutofillView | null = null;
  private shown = false;
  private bounds: Rectangle | null = null;
  /** When the dropdown became visible where it is now; 0 while it is not on screen. */
  private since = 0;

  constructor(private readonly win: BrowserWindowController) {}

  get webContents(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  get visible(): boolean {
    return this.shown;
  }

  private ensure(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.win.manager.uiSession,
        preload: paths.uiPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    this.view = view;
    this.ready = false;
    view.webContents.on('did-finish-load', () => {
      this.ready = true;
      if (this.last) view.webContents.send('ui:event', { type: 'autofill', ...this.last });
      if (this.shown) {
        view.setVisible(true);
        this.since = Date.now();
      }
    });
    view.webContents.on('render-process-gone', () => {
      this.view = null;
      this.shown = false;
      this.since = 0;
      if (!this.win.base.isDestroyed()) this.win.base.contentView.removeChildView(view);
    });
    void view.webContents.loadURL(`potato://autofill/${this.win.isPrivate ? '?private=1' : ''}`);
    return view;
  }

  /** `anchor`: the field, in window coordinates. Below it when there is room, else above. */
  show(state: AutofillView, anchor: Rectangle): void {
    if (this.win.base.isDestroyed()) return;
    const view = this.ensure();
    const { width: winW, height: winH } = this.win.base.getContentBounds();
    const rows = Math.min(MAX_ROWS, state.items.length);
    const height = MARGIN * 2 + PAD * 2 + rows * ROW + FOOT;
    const width = Math.min(winW, Math.max(260, Math.min(380, anchor.width)) + MARGIN * 2);
    const x = Math.max(0, Math.min(winW - width, anchor.x - MARGIN));
    let y = anchor.y + anchor.height + 2 - MARGIN;
    if (y + height > winH && anchor.y - height + MARGIN - 2 >= 0) y = anchor.y - height + MARGIN - 2;
    const bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height };
    const b = this.bounds;
    const moved = !b || b.x !== bounds.x || b.y !== bounds.y || b.width !== bounds.width || b.height !== bounds.height;
    this.bounds = bounds;
    view.setBounds(bounds);
    // Added last, so it sits above the page and the browser chrome.
    this.win.base.contentView.addChildView(view);
    this.update(state);
    this.shown = true;
    if (this.ready) {
      view.setVisible(true);
      if (moved || !this.since) this.since = Date.now();
    }
  }

  /** How long it has been on screen without moving; a page can move it under the pointer. */
  shownFor(): number {
    return this.since ? Date.now() - this.since : 0;
  }

  update(state: AutofillView): void {
    this.last = state;
    if (this.ready) this.view?.webContents.send('ui:event', { type: 'autofill', ...state });
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.since = 0;
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false);
  }

  destroy(): void {
    const view = this.view;
    this.view = null;
    this.shown = false;
    this.since = 0;
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }
}
