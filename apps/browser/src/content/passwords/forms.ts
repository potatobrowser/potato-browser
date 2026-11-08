/**
 * Login forms in a page (isolated world): finds username and password fields, asks the browser
 * to show saved logins when one gets focus, fills the login the user picks, and reports sign-ins
 * so the browser can offer to save them. Passwords reach the page only through `fill`, which the
 * browser calls after the user picked a login in its own dropdown.
 */

export type FieldKind = 'username' | 'password';
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PasswordsBridge {
  /** A login field got focus; `rect` is in the top frame's viewport (CSS pixels). */
  focus(f: { kind: FieldKind; rect: Rect; typed: string }): void;
  /** The field moved (scroll, resize); null when it is out of view. */
  move(rect: Rect | null): void;
  blur(): void;
  key(k: 'down' | 'up' | 'enter' | 'escape'): void;
  typed(text: string): void;
  hide(): void;
  submit(s: { username: string; fields: { value: string; autocomplete: string }[] }): void;
  /** A username was submitted without a password (the password comes on the next step). */
  username(u: string): void;
  /** No password field is visible anymore after a sign-in attempt (single page apps). */
  gone(): void;
  /** This page shows a password field (a failed sign-in comes back to one). */
  loginForm(): void;
}

export interface PasswordsOptions {
  autofill: boolean;
  save: boolean;
}

const TEXTLIKE = new Set(['text', 'email', 'tel', 'url']);
/** Names of a username field on a page without a password field (newsletter boxes do not count). */
const USERNAME_HINT = /user|login|ident|account|signin/i;
const NOT_USERNAME = /search|query|captcha|coupon|promo|voucher|otp|one-time|zip|postal/i;
/** Buttons that only show or hide the password, which are not sign-in attempts. */
const TOGGLE_HINT = /show|hide|reveal|visib|eye|toggle/i;
const AT_MSG = '__potatoPwAt';
const WHERE_MSG = '__potatoPwWhere';

const lower = (el: Element, name: string) => (el.getAttribute(name) || '').toLowerCase();
const hints = (el: HTMLInputElement) => `${el.name} ${el.id} ${lower(el, 'autocomplete')} ${el.placeholder} ${lower(el, 'aria-label')}`;

function visible(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
}

/** Inputs under `root` in document order, including those in open shadow roots. */
function deepInputs(root: Element | Document, cap = 4000): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  let seen = 0;
  const walk = (node: Element | Document | ShadowRoot) => {
    const w = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let el = w.nextNode() as Element | null; el && seen < cap; el = w.nextNode() as Element | null) {
      seen++;
      if (el instanceof HTMLInputElement) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

/** The innermost element of an event, inside open shadow roots. */
function target(e: Event): EventTarget | null {
  return e.composedPath()[0] ?? e.target;
}

function parentAcrossShadow(node: Node): Node | null {
  const p = node.parentNode;
  return p instanceof ShadowRoot ? p.host : p;
}

/** Sets a value the way typing does, so frameworks (React, Vue, Angular) see the change. */
function setValue(el: HTMLInputElement, value: string): void {
  if (el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Where this frame sits in the top frame's viewport, asked up the chain of parent frames. */
function frameOffset(): Promise<{ x: number; y: number } | null> {
  if (window === window.top) return Promise.resolve({ x: 0, y: 0 });
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (v: { x: number; y: number } | null) => {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Record<string, unknown> | null;
      if (e.source === window.parent && d && d[AT_MSG] === id && typeof d.x === 'number' && typeof d.y === 'number') done({ x: d.x, y: d.y });
    };
    const timer = setTimeout(() => done(null), 500);
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ [WHERE_MSG]: id }, '*');
  });
}

export class PasswordForms {
  private seenPassword = new WeakSet<HTMLInputElement>();
  /** The field the dropdown belongs to. */
  private active: HTMLInputElement | null = null;
  private popupOpen = false;
  private highlighted = false;
  /** The field the user last pressed the mouse on, and when. */
  private pressed: { el: EventTarget | null; at: number } = { el: null, at: -Infinity };
  /** When the user last pressed Tab in this document (performance.now() starts near 0 on load). */
  private tabbedAt = -Infinity;
  private lastAttempt = '';
  private lastAttemptAt = 0;
  private watch: ReturnType<typeof setInterval> | null = null;
  private moveQueued = false;

  constructor(
    private readonly bridge: PasswordsBridge,
    private opts: PasswordsOptions,
  ) {}

  start(): void {
    const capture = { capture: true };
    window.addEventListener('focusin', this.onFocusIn, capture);
    window.addEventListener('focusout', this.onFocusOut, capture);
    window.addEventListener('mousedown', this.onMouseDown, capture);
    window.addEventListener('keydown', this.onKeyDown, capture);
    window.addEventListener('input', this.onInput, capture);
    window.addEventListener('submit', this.onSubmit, capture);
    window.addEventListener('click', this.onClick, capture);
    window.addEventListener('scroll', this.onMove, { capture: true, passive: true });
    window.addEventListener('resize', this.onMove, { passive: true });
    window.addEventListener('message', this.onWhere);
    const report = () => setTimeout(() => this.opts.save && this.hasVisiblePassword() && this.bridge.loginForm(), 600);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', report, { once: true });
    else report();
  }

  update(opts: PasswordsOptions): void {
    this.opts = opts;
    if (!opts.autofill && this.popupOpen) this.bridge.hide();
  }

  popupState(open: boolean, highlighted: boolean): void {
    this.popupOpen = open;
    this.highlighted = open && highlighted;
  }

  /** Fills the login the user picked in the browser's dropdown into the active field's form. */
  fill(username: string, password: string): void {
    const el = this.active;
    if (!el?.isConnected) return;
    this.popupOpen = false;
    // Focus coming back to the field after the pick must not open the dropdown again.
    this.pressed = { el: null, at: -Infinity };
    this.tabbedAt = -Infinity;
    const { username: userField, passwords } = this.analyze(this.scopeOf(el));
    const pwField = passwords.find((p) => !lower(p, 'autocomplete').includes('new-password')) ?? (this.isPassword(el) ? el : null);
    const userTarget = userField ?? (this.isPassword(el) ? null : el);
    if (userTarget && username) setValue(userTarget, username);
    if (pwField) setValue(pwField, password);
  }

  // ---- fields ---------------------------------------------------------------------------------

  private isPassword(el: HTMLInputElement): boolean {
    if (el.type === 'password') {
      this.seenPassword.add(el);
      return true;
    }
    // A "show password" toggle turns the field into a text field.
    return this.seenPassword.has(el);
  }

  private usernameLike(el: HTMLInputElement): boolean {
    if (!TEXTLIKE.has(el.type) || el.disabled || el.readOnly) return false;
    const ac = lower(el, 'autocomplete');
    if (ac.includes('one-time-code')) return false;
    return ac.includes('username') || !NOT_USERNAME.test(hints(el));
  }

  /** The form, or the smallest container around the field that also holds a password field. */
  private scopeOf(el: Element): Element | Document {
    const form = (el as HTMLInputElement | HTMLButtonElement).form;
    if (form) return form;
    let node: Node | null = el;
    for (let depth = 0; depth < 12; depth++) {
      node = node && parentAcrossShadow(node);
      if (!(node instanceof Element)) break;
      if (node.tagName === 'FORM') return node;
      const inputs = deepInputs(node, 600);
      if (inputs.some((i) => this.isPassword(i) && visible(i)) && inputs.filter((i) => visible(i) && (this.isPassword(i) || TEXTLIKE.has(i.type))).length > 1) return node;
    }
    return document;
  }

  private analyze(scope: Element | Document): { username: HTMLInputElement | null; passwords: HTMLInputElement[]; hiddenUsername: string } {
    const inputs = deepInputs(scope);
    const passwords = inputs.filter((i) => this.isPassword(i) && visible(i));
    const first = passwords[0] ? inputs.indexOf(passwords[0]) : inputs.length;
    const before = inputs.slice(0, first).filter((i) => !this.isPassword(i) && this.usernameLike(i) && visible(i));
    const username = passwords.length
      ? (before.find((i) => /username|email/.test(lower(i, 'autocomplete'))) ?? before[before.length - 1] ?? null)
      : (before.find((i) => lower(i, 'autocomplete').includes('username') || USERNAME_HINT.test(`${i.name} ${i.id}`)) ?? null);
    // Sign-in steps that ask only for the password often keep the username in a hidden field.
    const hidden = inputs.find((i) => lower(i, 'autocomplete').includes('username') && i.value && (i.type === 'hidden' || !visible(i)));
    return { username, passwords, hiddenUsername: hidden?.value.trim() ?? '' };
  }

  private kindOf(el: HTMLInputElement): FieldKind | null {
    if (el.disabled || el.readOnly) return null;
    if (this.isPassword(el)) return lower(el, 'autocomplete').includes('new-password') ? null : 'password';
    if (!this.usernameLike(el)) return null;
    return this.analyze(this.scopeOf(el)).username === el ? 'username' : null;
  }

  private hasVisiblePassword(): boolean {
    return deepInputs(document).some((i) => this.isPassword(i) && visible(i));
  }

  // ---- dropdown -------------------------------------------------------------------------------

  private async rectOf(el: HTMLInputElement): Promise<Rect | null> {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth || r.width < 2) return null;
    const off = await frameOffset();
    return off ? { x: r.left + off.x, y: r.top + off.y, width: r.width, height: r.height } : null;
  }

  private async show(el: HTMLInputElement, kind: FieldKind): Promise<void> {
    this.active = el;
    const rect = await this.rectOf(el);
    if (!rect || this.active !== el || !this.opts.autofill) return;
    this.bridge.focus({ kind, rect, typed: kind === 'username' ? el.value : '' });
  }

  private onFocusIn = (e: FocusEvent): void => {
    if (!this.opts.autofill) return;
    const el = target(e);
    const kind = el instanceof HTMLInputElement ? this.kindOf(el) : null;
    if (!kind) {
      if (this.popupOpen) this.bridge.hide();
      return;
    }
    // Only the user opens the dropdown, by clicking the field or tabbing to it: never a page's
    // own focus() (autofocus, scripts), and not focus coming back after a fill or a tab switch.
    const now = performance.now();
    const byUser = (this.pressed.el === el && now - this.pressed.at < 1000) || now - this.tabbedAt < 1000;
    if (!byUser) {
      this.active = el as HTMLInputElement;
      return;
    }
    void this.show(el as HTMLInputElement, kind);
  };

  private onFocusOut = (e: FocusEvent): void => {
    if (this.opts.autofill && target(e) === this.active) this.bridge.blur();
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!e.isTrusted || e.button !== 0 || !this.opts.autofill) return;
    const el = target(e);
    if (!(el instanceof HTMLInputElement)) return;
    this.pressed = { el, at: performance.now() };
    // Already focused fields get no focusin; a click toggles the dropdown like a select.
    if (el === this.active && el.matches(':focus')) {
      if (this.popupOpen) this.bridge.hide();
      else {
        const kind = this.kindOf(el);
        if (kind) void this.show(el, kind);
      }
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!e.isTrusted) return;
    if (e.key === 'Tab') this.tabbedAt = performance.now();
    const el = target(e);
    if (!(el instanceof HTMLInputElement)) return;
    if (this.popupOpen && el === this.active) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.bridge.key(e.key === 'ArrowDown' ? 'down' : 'up');
        return;
      }
      if (e.key === 'Enter' && this.highlighted) {
        // Picks the highlighted login instead of submitting the form.
        e.preventDefault();
        e.stopImmediatePropagation();
        this.bridge.key('enter');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.bridge.key('escape');
        return;
      }
      if (e.key === 'Tab') this.bridge.hide();
    } else if (e.key === 'ArrowDown' && this.opts.autofill && !e.altKey && !e.metaKey) {
      const kind = this.kindOf(el);
      if (kind) void this.show(el, kind);
    }
    if (e.key === 'Enter') this.attempt(this.scopeOf(el));
  };

  private onInput = (e: Event): void => {
    const el = target(e);
    if (el instanceof HTMLInputElement && el === this.active && this.opts.autofill && e.isTrusted) this.bridge.typed(el.value);
  };

  private onMove = (): void => {
    if (!this.popupOpen || this.moveQueued) return;
    this.moveQueued = true;
    requestAnimationFrame(() => {
      this.moveQueued = false;
      const el = this.active;
      if (!el || !this.popupOpen) return;
      void this.rectOf(el).then((r) => this.popupOpen && this.bridge.move(r));
    });
  };

  /** Parent side of frameOffset: answers a child frame with its iframe's position. */
  private onWhere = (e: MessageEvent): void => {
    const d = e.data as Record<string, unknown> | null;
    const id = d && typeof d === 'object' ? d[WHERE_MSG] : null;
    if (typeof id !== 'string' || !this.opts.autofill || !e.source) return;
    const frame = [...document.querySelectorAll('iframe, frame')].find((f) => (f as HTMLIFrameElement).contentWindow === e.source);
    // Only for the frame the user is in: other frames (ads) learn nothing about where they sit.
    if (!frame || document.activeElement !== frame) return;
    const r = frame.getBoundingClientRect();
    const cs = getComputedStyle(frame);
    const x = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const y = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    void frameOffset().then((up) => {
      if (up) (e.source as Window).postMessage({ [AT_MSG]: id, x: x + up.x, y: y + up.y }, '*');
    });
  };

  // ---- saving ---------------------------------------------------------------------------------

  private onSubmit = (e: Event): void => {
    if (!e.isTrusted) return;
    const form = target(e);
    if (form instanceof HTMLFormElement) this.attempt(form);
  };

  private onClick = (e: MouseEvent): void => {
    if (!e.isTrusted || !this.opts.save) return;
    const t = target(e);
    if (!(t instanceof Element)) return;
    const button = t.closest('button, input[type=submit], input[type=button], input[type=image], [role=button]');
    if (!button || button.hasAttribute('aria-pressed')) return;
    const label = `${lower(button, 'aria-label')} ${lower(button, 'title')} ${button.id} ${button.className}`;
    if (TOGGLE_HINT.test(label)) return;
    this.attempt(this.scopeOf(button));
  };

  private attempt(scope: Element | Document): void {
    if (!this.opts.save) return;
    const { username, passwords, hiddenUsername } = this.analyze(scope);
    const fields = passwords.map((p) => ({ value: p.value, autocomplete: lower(p, 'autocomplete') })).filter((f) => f.value);
    if (!fields.length) {
      const u = username?.value.trim();
      if (u) this.bridge.username(u);
      return;
    }
    const user = username?.value.trim() || hiddenUsername;
    const key = JSON.stringify([user, fields]);
    if (key === this.lastAttempt && Date.now() - this.lastAttemptAt < 3000) return;
    this.lastAttempt = key;
    this.lastAttemptAt = Date.now();
    this.bridge.submit({ username: user, fields });
    this.watchGone();
  }

  /**
   * After a sign-in attempt: the password field staying away without a page load means success.
   * Single page apps often swap the form for a spinner while they check, so it must stay gone
   * for a while, and coming back afterwards still counts as a failed sign-in.
   */
  private watchGone(): void {
    if (this.watch) clearInterval(this.watch);
    const started = Date.now();
    let goneSince = 0;
    let reportedAt = 0;
    const stop = () => {
      clearInterval(this.watch!);
      this.watch = null;
    };
    this.watch = setInterval(() => {
      const now = Date.now();
      const visible = this.hasVisiblePassword();
      if (reportedAt) {
        if (visible) this.bridge.loginForm();
        if (visible || now - reportedAt > 5000) stop();
        return;
      }
      if (visible) goneSince = 0;
      else if (!goneSince) goneSince = now;
      else if (now - goneSince >= 2000) {
        reportedAt = now;
        this.bridge.gone();
        return;
      }
      if (now - started > 15_000) stop();
    }, 250);
  }
}
