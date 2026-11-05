import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { Suggestion, TabState } from '../../shared/types';
import { prettyUrl } from '../../shared/urls';
import { chrome } from '../shared/api';
import { BrandMark, Clock, Globe, Lock, Search, Star, Warning } from '../shared/icons';

export interface OmniboxHandle {
  focus(): void;
}

interface Props {
  tab: TabState | null;
  isPrivate: boolean;
  onDropdown(open: boolean): void;
  ref?: Ref<OmniboxHandle>;
}

function SuggestionIcon({ s }: { s: Suggestion }) {
  if (s.kind === 'search' || s.kind === 'suggest') return <Search />;
  if (s.kind === 'history') return <Clock />;
  if (s.kind === 'bookmark') return <Star />;
  return <Globe />;
}

export function Omnibox({ tab, isPrivate, onDropdown, ref }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(-1);
  const typed = useRef('');
  const inlineActive = useRef(false);
  // Selection to apply right after React commits a new value. A layout effect runs before the
  // next input event, so a fast keystroke can never land between the value and its selection.
  const pendingSelection = useRef<[number, number] | null>(null);
  const url = tab?.url ?? '';

  useImperativeHandle(ref, () => ({
    focus() {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.select();
    },
  }));

  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    if (!sel || !input.current) return;
    pendingSelection.current = null;
    input.current.setSelectionRange(sel[0], sel[1]);
  }, [value]);

  // Show the page URL whenever the user is not editing.
  useEffect(() => {
    if (!editing) setValue(url);
  }, [url, editing]);

  const open = suggestions.length > 0 && editing;
  useEffect(() => onDropdown(open), [open, onDropdown]);

  const close = useCallback(() => {
    setSuggestions([]);
    setSelected(-1);
  }, []);

  const query = useCallback((text: string, deleting: boolean) => {
    if (!text.trim()) {
      close();
      return;
    }
    void chrome()
      .suggest(text)
      .then((res) => {
        if (res.input !== typed.current) return;
        setSuggestions(res.suggestions);
        setSelected(-1);
        const lower = text.toLowerCase();
        if (!deleting && res.inline && res.inline.startsWith(lower) && res.inline.length > text.length && !/\s/.test(text)) {
          const completed = text + res.inline.slice(text.length);
          inlineActive.current = true;
          pendingSelection.current = [text.length, completed.length];
          setValue(completed);
        } else {
          inlineActive.current = false;
        }
      });
  }, [close]);

  const navigate = (target: { input?: string; url?: string }, newTab: boolean) => {
    if (target.url) chrome().send({ type: 'nav.open', url: target.url, newTab });
    else if (target.input?.trim()) chrome().send({ type: 'nav.go', input: target.input, newTab });
    else return;
    close();
    setEditing(false);
    input.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const newTab = e.metaKey || e.altKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(suggestions.length - 1, selected + 1) : Math.max(-1, selected - 1);
      setSelected(next);
      inlineActive.current = false;
      setValue(next >= 0 ? suggestions[next]!.fill : typed.current);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = selected >= 0 ? suggestions[selected] : null;
      if (s) navigate({ url: s.url }, newTab);
      else navigate({ input: value }, newTab);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open) {
        close();
        setValue(typed.current);
      } else {
        setValue(url);
        setEditing(false);
        input.current?.blur();
        chrome().send({ type: 'ui.focusPage' });
      }
    } else if (e.key === 'Tab' && inlineActive.current && !e.shiftKey) {
      e.preventDefault();
      const el = input.current!;
      el.setSelectionRange(value.length, value.length);
      inlineActive.current = false;
      typed.current = value;
      query(value, true);
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
    const deleting = inputType.startsWith('delete') || v.length < typed.current.length;
    typed.current = v;
    setValue(v);
    setEditing(true);
    query(v, deleting);
  };

  const pretty = prettyUrl(url);
  const showPretty = !editing && !!url && !url.startsWith('noai://');
  const security = tab?.security ?? 'none';

  return (
    <div className={`omnibox${editing ? ' editing' : ''}`} data-testid="omnibox">
      <span className={`omni-icon sec-${security}`} title={security === 'secure' ? 'Connection is secure' : security === 'insecure' ? 'Not secure' : ''}>
        {editing || !url ? (
          <Search />
        ) : security === 'secure' ? (
          <Lock />
        ) : security === 'insecure' ? (
          <Warning />
        ) : security === 'internal' ? (
          <BrandMark size={14} />
        ) : (
          <Globe />
        )}
      </span>
      {security === 'insecure' && !editing && url ? <span className="not-secure">Not secure</span> : null}
      <input
        ref={input}
        data-testid="omnibox-input"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={isPrivate ? 'Search privately or enter address' : 'Search or enter address'}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          setEditing(true);
          typed.current = e.target.value;
          e.target.select();
        }}
        onBlur={() => {
          setEditing(false);
          close();
          setValue(url);
        }}
        className={showPretty ? 'hide-text' : ''}
      />
      {showPretty && (
        <span className="pretty" aria-hidden="true">
          <span className="host">{pretty.host}</span>
          <span className="rest">{pretty.rest}</span>
        </span>
      )}
      {tab && tab.zoom && Math.abs(tab.zoom - 1) > 0.001 ? (
        <button className="chip" title="Reset zoom" onClick={() => chrome().send({ type: 'zoom.reset' })}>
          {Math.round(tab.zoom * 100)}%
        </button>
      ) : null}
      {tab && tab.url && !tab.url.startsWith('noai://') ? (
        <button
          className={`omni-btn${tab.bookmarked ? ' active' : ''}`}
          data-testid="bookmark-star"
          title={tab.bookmarked ? 'Remove bookmark' : 'Bookmark this tab'}
          aria-pressed={tab.bookmarked}
          onClick={() => chrome().send({ type: 'bookmark.toggle' })}
        >
          <Star filled={tab.bookmarked} />
        </button>
      ) : null}
      {open && (
        <ul className="suggestions" role="listbox" data-testid="suggestions" onMouseDown={(e) => e.preventDefault()}>
          {suggestions.map((s, i) => (
            <li
              key={s.kind + s.url}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? 'selected' : ''}
              onMouseEnter={() => setSelected(i)}
              onClick={(e) => navigate({ url: s.url }, e.metaKey)}
            >
              <span className="s-icon">
                <SuggestionIcon s={s} />
              </span>
              <span className="s-title">{s.title}</span>
              {s.kind === 'history' || s.kind === 'bookmark' || (s.kind === 'url' && s.title !== s.fill && s.title !== s.url) ? (
                <span className="s-url">{prettyUrl(s.url).host}</span>
              ) : null}
              {s.kind === 'search' ? <span className="s-url">Search</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
