import { useRef, useState } from 'react';
import type { TabState } from '../../shared/types';
import { chrome } from '../shared/api';
import { Close, Globe, Mask, Plus, Speaker } from '../shared/icons';

interface Props {
  tabs: TabState[];
  activeId: number;
  isPrivate: boolean;
  fullscreen: boolean;
}

interface Drag {
  id: number;
  startX: number;
  dx: number;
  moved: boolean;
  from: number;
  width: number;
}

function TabIcon({ tab }: { tab: TabState }) {
  if (tab.loading) return <span className="spinner" aria-label="Loading" />;
  if (tab.favicon) return <img className="favicon" src={tab.favicon} alt="" draggable={false} />;
  return <Globe size={14} />;
}

export function TabStrip({ tabs, activeId, isPrivate, fullscreen }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const targetIndex = (d: Drag) => Math.max(0, Math.min(tabs.length - 1, d.from + Math.round(d.dx / Math.max(1, d.width))));

  const onPointerDown = (e: React.PointerEvent, tab: TabState, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tab-close, .tab-audio')) return;
    if (tab.id !== activeId) chrome().send({ type: 'tab.activate', tabId: tab.id });
    const width = (e.currentTarget as HTMLElement).getBoundingClientRect().width;
    dragRef.current = { id: tab.id, startX: e.clientX, dx: 0, moved: false, from: index, width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 5) return;
    d.moved = true;
    d.dx = dx;
    setDrag({ ...d });
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d?.moved) {
      const to = targetIndex(d);
      if (to !== d.from) chrome().send({ type: 'tab.move', tabId: d.id, index: to });
    }
  };

  const dropAt = drag ? targetIndex(drag) : -1;

  return (
    <div className={`tabstrip${fullscreen ? ' fullscreen' : ''}`} data-testid="tabstrip">
      <div className="tabs" ref={listRef} role="tablist">
        {tabs.map((tab, i) => {
          let shift = 0;
          if (drag && tab.id !== drag.id) {
            if (drag.from < i && i <= dropAt) shift = -drag.width;
            else if (drag.from > i && i >= dropAt) shift = drag.width;
          }
          const style = drag?.id === tab.id ? { transform: `translateX(${drag.dx}px)`, zIndex: 3 } : shift ? { transform: `translateX(${shift}px)` } : undefined;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId}
              data-testid="tab"
              data-tab-id={tab.id}
              className={`tab${tab.id === activeId ? ' active' : ''}${drag?.id === tab.id ? ' dragging' : ''}${drag ? ' anim' : ''}`}
              style={style}
              title={tab.title}
              onPointerDown={(e) => onPointerDown(e, tab, i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onAuxClick={(e) => {
                if (e.button === 1) chrome().send({ type: 'tab.close', tabId: tab.id });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                chrome().send({ type: 'tab.menu', tabId: tab.id });
              }}
            >
              <span className="tab-icon">
                <TabIcon tab={tab} />
              </span>
              <span className="tab-title" data-testid="tab-title">{tab.title}</span>
              {tab.audible || tab.muted ? (
                <button
                  className="tab-audio"
                  title={tab.muted ? 'Unmute tab' : 'Mute tab'}
                  onClick={() => chrome().send({ type: 'tab.mute', tabId: tab.id })}
                >
                  <Speaker muted={tab.muted} size={13} />
                </button>
              ) : null}
              <button
                className="tab-close"
                data-testid="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  chrome().send({ type: 'tab.close', tabId: tab.id });
                }}
              >
                <Close size={12} />
              </button>
            </div>
          );
        })}
        <button className="newtab-btn" data-testid="new-tab" title="New tab" onClick={() => chrome().send({ type: 'tab.new' })}>
          <Plus />
        </button>
      </div>
      {isPrivate && (
        <span className="private-pill" data-testid="private-indicator" title="Private window: nothing is saved after you close it">
          <Mask size={14} /> Private
        </span>
      )}
    </div>
  );
}
