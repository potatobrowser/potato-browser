import { useEffect, useRef, useState } from 'react';
import type { BookmarkNode, FindState, PermissionPrompt } from '../../shared/types';
import { chrome } from '../shared/api';
import { ChevronDown, ChevronUp, Close, Folder, Globe } from '../shared/icons';

export function BookmarksBar({ items }: { items: BookmarkNode[] }) {
  if (!items.length) {
    return (
      <div className="bookmarks-bar empty" data-testid="bookmarks-bar">
        <span>Bookmarks you add appear here.</span>
        <button className="link" onClick={() => chrome().send({ type: 'command', name: 'showImport' })}>
          Import bookmarks from another browser
        </button>
      </div>
    );
  }
  return (
    <div className="bookmarks-bar" data-testid="bookmarks-bar">
      {items.map((b) => (
        <button
          key={b.id}
          className="bm"
          data-testid="bookmark-item"
          title={b.url ? `${b.title}\n${b.url}` : b.title}
          onClick={(e) => {
            if (b.type === 'folder') {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              chrome().send({ type: 'bookmark.folder', id: b.id, x: r.left, y: r.bottom + 2 });
            } else {
              chrome().send({ type: 'bookmark.open', id: b.id, newTab: e.metaKey, background: e.metaKey && !e.shiftKey });
            }
          }}
          onAuxClick={(e) => {
            if (e.button === 1 && b.type === 'url') chrome().send({ type: 'bookmark.open', id: b.id, newTab: true, background: true });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            chrome().send({ type: 'bookmark.context', id: b.id, x: e.clientX, y: e.clientY });
          }}
        >
          {b.type === 'folder' ? <Folder size={14} /> : b.favicon ? <img className="favicon" src={b.favicon} alt="" /> : <Globe size={14} />}
          <span>{b.title || b.url}</span>
        </button>
      ))}
    </div>
  );
}

export function FindBar({ find, focusToken }: { find: FindState; focusToken: number }) {
  const [text, setText] = useState(find.text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);
  const query = (t: string, forward = true, findNext = false) => chrome().send({ type: 'find.query', text: t, forward, findNext });
  return (
    <div className="findbar" data-testid="findbar">
      <input
        ref={input}
        data-testid="find-input"
        placeholder="Find in page"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          query(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') query(text, !e.shiftKey, true);
          if (e.key === 'Escape') chrome().send({ type: 'find.close' });
        }}
      />
      <span className="find-count" data-testid="find-count">
        {text ? `${find.active}/${find.matches}` : ''}
      </span>
      <button className="icon-btn" title="Previous match" onClick={() => query(text, false, true)}>
        <ChevronUp />
      </button>
      <button className="icon-btn" title="Next match" onClick={() => query(text, true, true)}>
        <ChevronDown />
      </button>
      <button className="icon-btn" title="Close" onClick={() => chrome().send({ type: 'find.close' })}>
        <Close size={13} />
      </button>
    </div>
  );
}

export function Infobars({ prompts }: { prompts: PermissionPrompt[] }) {
  return (
    <>
      {prompts.map((p) => (
        <div className="infobar" key={p.id} data-testid="permission-prompt" role="alertdialog">
          <span>
            <strong>{p.origin.replace(/^https?:\/\//, '')}</strong> wants to {p.description}
          </span>
          <span className="infobar-actions">
            <button className="btn" data-testid="permission-block" onClick={() => chrome().send({ type: 'permission.respond', id: p.id, allow: false })}>
              Block
            </button>
            <button className="btn primary" data-testid="permission-allow" onClick={() => chrome().send({ type: 'permission.respond', id: p.id, allow: true })}>
              Allow
            </button>
          </span>
        </div>
      ))}
    </>
  );
}
