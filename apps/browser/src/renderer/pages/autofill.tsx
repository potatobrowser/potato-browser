import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AutofillView } from '../../shared/types';
import { chrome } from '../shared/api';
import { Key } from '../shared/icons';
import './autofill.css';

/** The saved-logins dropdown the browser shows under a login field. */
function Autofill() {
  const [view, setView] = useState<AutofillView>({ items: [], highlighted: -1 });
  const list = useRef<HTMLUListElement>(null);
  useEffect(
    () =>
      chrome().onEvent((e) => {
        if (e.type === 'autofill') setView({ items: (e.items as AutofillView['items']) ?? [], highlighted: Number(e.highlighted ?? -1) });
      }),
    [],
  );
  useEffect(() => {
    list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [view.highlighted]);
  // A press here blurs the page's field; tell the browser to keep the dropdown for the click.
  const hold = () => chrome().send({ type: 'autofill.hold' });
  return (
    <div className="card" role="listbox" aria-label="Saved passwords" data-testid="autofill" onPointerDown={hold}>
      <ul ref={list}>
        {view.items.map((item, i) => (
          <li
            key={i}
            role="option"
            aria-selected={i === view.highlighted}
            data-testid="autofill-item"
            onClick={() => chrome().send({ type: 'autofill.pick', index: i })}
          >
            <span className="icon">
              <Key size={15} />
            </span>
            <span className="text">
              <span className="user">{item.username || 'No username'}</span>
              <span className="sub">{item.host ?? '••••••••••'}</span>
            </span>
          </li>
        ))}
      </ul>
      <button className="manage" onClick={() => chrome().send({ type: 'autofill.manage' })}>
        Manage passwords...
      </button>
    </div>
  );
}

if (new URLSearchParams(location.search).has('private')) document.documentElement.classList.add('private');
createRoot(document.getElementById('root')!).render(<Autofill />);
