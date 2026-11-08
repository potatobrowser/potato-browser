import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { chrome } from '../shared/api';
import { AdBlock, Back, Close, Download, Forward, Menu, Reload, Shield } from '../shared/icons';
import { BookmarksBar, FindBar, Infobars, PasswordBar } from './Bars';
import { Omnibox, type OmniboxHandle } from './Omnibox';
import { AdblockPanel, DownloadsPanel, ShieldPanel } from './Panels';
import { TabStrip } from './TabStrip';

type Popover = 'shield' | 'adblock' | 'downloads' | null;

export function App() {
  const [state, setState] = useState<WindowState | null>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [dropdown, setDropdown] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [anchor, setAnchor] = useState<{ right: number; top: number }>({ right: 8, top: 80 });
  const chromeRef = useRef<HTMLDivElement>(null);
  const omnibox = useRef<OmniboxHandle>(null);

  useEffect(() => chrome().onState(setState), []);
  useEffect(
    () =>
      chrome().onEvent((e) => {
        if (e.type === 'focus-omnibox') {
          setPopover(null);
          omnibox.current?.focus();
        } else if (e.type === 'open-find') {
          setFindFocus((n) => n + 1);
        }
      }),
    [],
  );

  // Report the chrome's height so the page view sits right below it.
  useLayoutEffect(() => {
    const el = chromeRef.current;
    if (!el) return;
    const send = () => chrome().send({ type: 'ui.height', height: el.getBoundingClientRect().height });
    const ro = new ResizeObserver(send);
    ro.observe(el);
    send();
    return () => ro.disconnect();
  }, [state === null]);

  const overlay = popover !== null || dropdown;
  useEffect(() => {
    chrome().send({ type: 'ui.overlay', open: overlay });
  }, [overlay]);

  const onDropdown = useCallback((open: boolean) => setDropdown(open), []);

  const openPopover = (which: Popover, e: React.MouseEvent) => {
    if (popover === which) {
      setPopover(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ right: Math.max(8, window.innerWidth - r.right - 4), top: r.bottom + 6 });
    setPopover(which);
  };

  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPopover(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popover]);

  if (!state) return null;
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const shield = tab?.shield;
  const web = !!shield?.host;
  const shieldOn = web && !!shield?.enabled && state.shieldGloballyEnabled;
  const shieldCount = shieldOn ? shield!.hiddenCount : 0;
  const flagCount = (tab?.flags.hidden ?? 0) + (tab?.flags.labeled ?? 0);
  const adOn = web && !!tab?.adblock.enabled && state.adblockGloballyEnabled;
  const adCount = adOn ? tab!.adblock.blocked : 0;
  const dl = state.downloads;

  return (
    <div className={`app${state.isPrivate ? ' private' : ''}`} data-private={state.isPrivate || undefined}>
      <div className="chrome" ref={chromeRef}>
        <TabStrip tabs={state.tabs} activeId={state.activeTabId} isPrivate={state.isPrivate} fullscreen={state.fullscreen} />
        <div className="toolbar">
          <button className="icon-btn" data-testid="back" title="Back" disabled={!tab?.canGoBack} onClick={() => chrome().send({ type: 'nav.back' })}>
            <Back />
          </button>
          <button className="icon-btn" data-testid="forward" title="Forward" disabled={!tab?.canGoForward} onClick={() => chrome().send({ type: 'nav.forward' })}>
            <Forward />
          </button>
          {tab?.loading ? (
            <button className="icon-btn" data-testid="stop" title="Stop loading" onClick={() => chrome().send({ type: 'nav.stop' })}>
              <Close />
            </button>
          ) : (
            <button className="icon-btn" data-testid="reload" title="Reload" onClick={(e) => chrome().send({ type: 'nav.reload', hard: e.shiftKey })}>
              <Reload />
            </button>
          )}
          <Omnibox ref={omnibox} tab={tab} isPrivate={state.isPrivate} onDropdown={onDropdown} />
          <button
            className={`icon-btn shield-btn${shieldOn ? ' on' : web && !shield?.enabled ? ' off' : ''}${popover === 'shield' ? ' pressed' : ''}`}
            data-testid="shield-button"
            data-state={shieldOn ? 'on' : web ? 'off' : 'na'}
            title={!web ? 'AI Shield' : shieldOn ? `AI Shield is on for ${shield!.host}` : `AI features are shown on ${shield!.host}`}
            aria-label="AI Shield"
            onClick={(e) => openPopover('shield', e)}
          >
            <Shield filled={shieldOn && shieldCount > 0} off={web && !shieldOn} />
            {shieldCount > 0 ? <span className="badge" data-testid="shield-badge">{shieldCount > 99 ? '99+' : shieldCount}</span> : null}
            {flagCount > 0 ? <span className="badge flag" data-testid="flag-badge" title="Flagged posts">{flagCount}</span> : null}
          </button>
          <button
            className={`icon-btn adblock-btn${adOn ? ' on' : web ? ' off' : ''}${popover === 'adblock' ? ' pressed' : ''}`}
            data-testid="adblock-button"
            data-state={adOn ? 'on' : web ? 'off' : 'na'}
            title={!web ? 'Ad blocker' : adOn ? `Ad blocker is on for ${shield!.host}` : `Ads are allowed on ${shield!.host}`}
            aria-label="Ad blocker"
            onClick={(e) => openPopover('adblock', e)}
          >
            <AdBlock filled={adOn && adCount > 0} off={web && !adOn} />
            {adCount > 0 ? <span className="badge ad" data-testid="adblock-badge">{adCount > 99 ? '99+' : adCount}</span> : null}
          </button>
          {dl.recent.length > 0 ? (
            <button
              className={`icon-btn${dl.active ? ' active-dl' : ''}${popover === 'downloads' ? ' pressed' : ''}`}
              data-testid="downloads-button"
              title="Downloads"
              onClick={(e) => openPopover('downloads', e)}
            >
              <Download />
              {dl.active ? <span className="badge">{dl.active}</span> : null}
            </button>
          ) : null}
          <button
            className="icon-btn"
            data-testid="menu-button"
            title="Menu"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              chrome().send({ type: 'ui.menu', x: r.left, y: r.bottom + 4 });
            }}
          >
            <Menu />
            {state.updateAvailable ? <span className="dot" title={`Update available: ${state.updateAvailable}`} /> : null}
          </button>
        </div>
        {state.bookmarksBar !== null && <BookmarksBar items={state.bookmarksBar} />}
        {state.find && <FindBar find={state.find} focusToken={findFocus} />}
        <Infobars prompts={state.permissionPrompts} />
        {state.passwordPrompt && <PasswordBar key={state.passwordPrompt.id} prompt={state.passwordPrompt} />}
      </div>
      {popover && (
        <>
          <div className="backdrop" data-testid="backdrop" onMouseDown={() => setPopover(null)} />
          <div className="popover" style={{ right: anchor.right, top: anchor.top }}>
            {popover === 'shield' ? (
              <ShieldPanel tab={tab} globallyEnabled={state.shieldGloballyEnabled} />
            ) : popover === 'adblock' ? (
              <AdblockPanel tab={tab} globallyEnabled={state.adblockGloballyEnabled} />
            ) : (
              <DownloadsPanel items={dl.recent} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
