import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BookmarkNode } from '../../shared/types';
import { prettyUrl } from '../../shared/urls';
import { call, onInternalEvent } from '../shared/api';
import { Card, Favicon } from '../shared/components';
import { Close, Folder, Plus, Search, Star } from '../shared/icons';
import '../shared/pages.css';
import './bookmarks.css';

function flatten(nodes: BookmarkNode[], out: BookmarkNode[] = []): BookmarkNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

function Bookmarks() {
  const [tree, setTree] = useState<BookmarkNode[]>([]);
  const [folderId, setFolderId] = useState(1);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const load = useCallback(() => void call<BookmarkNode[]>('bookmarks.tree').then(setTree), []);
  useEffect(() => {
    load();
    return onInternalEvent((e) => e.type === 'bookmarks' && load());
  }, [load]);

  const all = useMemo(() => flatten(tree), [tree]);
  const folder = all.find((n) => n.id === folderId);
  const list = q.trim()
    ? all.filter((n) => n.type === 'url' && `${n.title} ${n.url}`.toLowerCase().includes(q.toLowerCase()))
    : (folder?.children ?? []);
  const folders = all.filter((n) => n.type === 'folder');

  const path = (n: BookmarkNode | undefined): BookmarkNode[] => {
    const out: BookmarkNode[] = [];
    for (let c = n; c; c = all.find((x) => x.id === c!.parentId)) out.unshift(c);
    return out;
  };

  const renderFolder = (n: BookmarkNode, depth: number): React.ReactNode => (
    <li key={n.id}>
      <button className={`folder${n.id === folderId && !q ? ' on' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => { setQ(''); setFolderId(n.id); }}>
        <Folder size={15} /> <span className="truncate">{n.title}</span>
      </button>
      {n.children?.some((c) => c.type === 'folder') ? <ul>{n.children.filter((c) => c.type === 'folder').map((c) => renderFolder(c, depth + 1))}</ul> : null}
    </li>
  );

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>
          <Star size={24} /> Bookmarks
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {newFolder === null ? (
            <button className="btn" onClick={() => setNewFolder('New folder')}>
              <Plus size={14} /> New folder
            </button>
          ) : (
            <form
              className="edit-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (newFolder.trim()) await call('bookmarks.add', { parentId: folderId, type: 'folder', title: newFolder.trim() });
                setNewFolder(null);
                load();
              }}
            >
              <input className="input" aria-label="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} autoFocus />
              <button className="btn primary">Add</button>
              <button className="btn" type="button" onClick={() => setNewFolder(null)}>
                Cancel
              </button>
            </form>
          )}
          <a className="btn" href="potato://settings/#import">
            Import
          </a>
        </div>
      </div>
      <div className="bm-layout">
        <aside>
          <ul className="folders">{tree.map((r) => renderFolder(r, 0))}</ul>
        </aside>
        <div>
          <div className="search" style={{ marginBottom: 12 }}>
            <Search />
            <input data-testid="bookmarks-search" placeholder="Search bookmarks" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!q && folder && (
            <div className="crumbs">
              {path(folder).map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ' / '}
                  <button className="link-btn" onClick={() => setFolderId(p.id)}>
                    {p.title}
                  </button>
                </span>
              ))}
            </div>
          )}
          <Card>
            {list.length === 0 ? (
              <div className="empty">{q ? 'No matching bookmarks.' : 'This folder is empty. Plant something.'}</div>
            ) : (
              <ul className="list" data-testid="bookmark-list">
                {list.map((n) => (
                  <li key={n.id} className="list-item" data-testid="bookmark-row">
                    {n.type === 'folder' ? (
                      <span className="fav">
                        <Folder size={16} />
                      </span>
                    ) : (
                      <Favicon src={null} />
                    )}
                    {editing === n.id ? (
                      <form
                        className="grow edit-form"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const fd = new FormData(e.currentTarget);
                          await call('bookmarks.update', n.id, { title: String(fd.get('title')), url: n.type === 'url' ? String(fd.get('url')) : undefined });
                          setEditing(null);
                          load();
                        }}
                      >
                        <input className="input" name="title" defaultValue={n.title} autoFocus />
                        {n.type === 'url' && <input className="input" name="url" defaultValue={n.url ?? ''} />}
                        <button className="btn primary">Save</button>
                        <button className="btn" type="button" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : n.type === 'folder' ? (
                      <button className="grow row-btn truncate" onClick={() => { setQ(''); setFolderId(n.id); }}>
                        {n.title}
                      </button>
                    ) : (
                      <a className="grow truncate plain" href={n.url ?? '#'} title={n.url ?? ''}>
                        {n.title || n.url} <span className="muted">{prettyUrl(n.url ?? '').host}</span>
                      </a>
                    )}
                    {editing !== n.id && (
                      <>
                        <button className="btn small" onClick={() => setEditing(n.id)}>
                          Edit
                        </button>
                        <select
                          className="move"
                          aria-label="Move to folder"
                          value=""
                          onChange={async (e) => {
                            await call('bookmarks.move', n.id, Number(e.target.value), 1e6);
                            load();
                          }}
                        >
                          <option value="" disabled>
                            Move...
                          </option>
                          {folders.filter((f) => f.id !== n.id).map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.title}
                            </option>
                          ))}
                        </select>
                        <button
                          className="icon-btn"
                          aria-label="Delete bookmark"
                          data-testid="bookmark-delete"
                          onClick={async () => {
                            await call('bookmarks.remove', n.id);
                            load();
                          }}
                        >
                          <Close size={13} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Bookmarks />);
