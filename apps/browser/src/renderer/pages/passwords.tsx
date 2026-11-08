import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoginInfo, PasswordImportResult, PasswordsOverview, Settings } from '../../shared/types';
import { call, onInternalEvent } from '../shared/api';
import { Card, Favicon, Row, Toggle, useSettings } from '../shared/components';
import { Close, Copy, Eye, EyeOff, Key, Plus, Search } from '../shared/icons';
import '../shared/pages.css';
import './passwords.css';

type Login = LoginInfo & { favicon: string | null };
type Overview = Omit<PasswordsOverview, 'logins'> & { logins: Login[]; keychainError: string | null };
type Update = ReturnType<typeof useSettings>[1];

const KEYCHAIN_DENIED = 'The macOS Keychain did not give access to the passwords. If macOS asked, choose Always Allow.';

function useCopied(): [string | null, (key: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return [copied, setCopied];
}

function LoginRow({ login, onError }: { login: Login; onError(msg: string): void }) {
  const [secret, setSecret] = useState<{ password: string; note: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ username: '', password: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useCopied();

  const reveal = async () => {
    try {
      const s = await call<{ password: string; note: string } | null>('passwords.reveal', login.id);
      if (s) setSecret(s);
      return s;
    } catch {
      onError(KEYCHAIN_DENIED);
      return null;
    }
  };
  const copy = async (what: 'username' | 'password') => {
    if (await call<boolean>('passwords.copy', login.id, what).catch(() => false)) setCopied(what);
  };
  const edit = async () => {
    const s = secret ?? (await reveal());
    if (!s) return;
    setDraft({ username: login.username, password: s.password, note: s.note });
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const r = await call<{ error?: string }>('passwords.update', login.id, draft);
    if (r.error) return setError(r.error);
    setSecret({ password: draft.password, note: draft.note });
    setEditing(false);
  };

  return (
    <li className="login" data-testid="login-row" data-host={login.host}>
      <div className="login-main">
        <Favicon src={login.favicon} />
        <div className="login-site grow">
          <a className="truncate" href={login.origin} target="_blank" rel="noreferrer" title={login.origin}>
            {login.host}
          </a>
          <span className="login-user truncate muted" data-testid="login-username">
            {login.username || 'No username'}
          </span>
        </div>
        <span className="login-secret mono" data-testid="login-password">
          {secret ? secret.password : '••••••••••'}
        </span>
        <span className="login-actions">
          <button className="icon-btn" title={secret ? 'Hide password' : 'Show password'} aria-label={secret ? 'Hide password' : 'Show password'} data-testid="login-reveal" onClick={() => (secret ? setSecret(null) : void reveal())}>
            {secret ? <EyeOff /> : <Eye />}
          </button>
          <button className="icon-btn" title="Copy password" aria-label="Copy password" data-testid="login-copy" onClick={() => void copy('password')}>
            <Copy />
          </button>
          <button className="btn small" data-testid="login-edit" onClick={() => void edit()}>
            Edit
          </button>
          <button
            className="icon-btn"
            title="Delete"
            aria-label="Delete"
            data-testid="login-delete"
            onClick={() => {
              if (confirm(`Delete the saved password for ${login.username || 'no username'} on ${login.host}?`)) void call('passwords.remove', login.id);
            }}
          >
            <Close size={13} />
          </button>
        </span>
      </div>
      {copied ? <div className="login-note ok-text">{copied === 'password' ? 'Password copied.' : 'Username copied.'}</div> : null}
      {secret?.note && !editing ? <div className="login-note muted">{secret.note}</div> : null}
      {editing ? (
        <form
          className="login-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Username
            <input className="input" data-testid="edit-username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} spellCheck={false} />
          </label>
          <label>
            Password
            <input className="input mono" data-testid="edit-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} spellCheck={false} />
          </label>
          <label className="wide">
            Note
            <textarea className="input" rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </label>
          <div className="wide edit-actions">
            {error ? <span className="warn-text">{error}</span> : null}
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn primary" data-testid="edit-save">
              Save
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

function AddLogin({ onDone }: { onDone(): void }) {
  const [draft, setDraft] = useState({ origin: '', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="login-edit add"
      data-testid="add-login"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await call<{ error?: string }>('passwords.add', draft);
        if (r.error) setError(r.error);
        else onDone();
      }}
    >
      <label className="wide">
        Website
        <input className="input" autoFocus placeholder="example.com" value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.target.value })} spellCheck={false} />
      </label>
      <label>
        Username
        <input className="input" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} spellCheck={false} />
      </label>
      <label>
        Password
        <input className="input mono" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} spellCheck={false} />
      </label>
      <div className="wide edit-actions">
        {error ? <span className="warn-text">{error}</span> : null}
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Save password
        </button>
      </div>
    </form>
  );
}

const EXPORT_STEPS: [string, string][] = [
  ['Chrome, Edge, Brave or Arc', 'Open Settings, then Passwords (Google Password Manager in Chrome). Under its settings choose Export passwords and save the file.'],
  ['Safari', 'Choose File > Export > Passwords. On macOS 15 and later, open the Passwords app and choose File > Export All Passwords.'],
  ['Firefox', 'Open Passwords (about:logins), click the three dots menu and choose Export Passwords.'],
  ['1Password', 'Choose File > Export, pick your account and the CSV format. 1Password exports logins with their notes; archived items stay behind.'],
];

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function importSummary(r: PasswordImportResult): string {
  const parts = [`Imported ${plural(r.added, 'password', 'passwords')}${r.source ? ` from ${r.source}` : ''}.`];
  if (r.same) parts.push(`${plural(r.same, 'was', 'were')} already saved.`);
  if (r.kept) parts.push(`${plural(r.kept, 'login was', 'logins were')} already saved with a different password; the saved one stays.`);
  const s = r.skipped;
  const missing = s.noPassword + s.noWebsite;
  if (missing) parts.push(`${plural(missing, 'row has', 'rows have')} no website or password and ${missing === 1 ? 'was' : 'were'} left out.`);
  if (s.archived) parts.push(`${plural(s.archived, 'archived item was', 'archived items were')} left out.`);
  if (s.duplicates) parts.push(`${plural(s.duplicates, 'duplicate', 'duplicates')} skipped.`);
  return parts.join(' ');
}

function ImportCard() {
  const [result, setResult] = useState<PasswordImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [trashed, setTrashed] = useState(false);
  return (
    <Card
      title="Import passwords"
      id="import"
      hint="Bring your passwords over from another browser or password manager: export them there as a CSV file, then choose the file here. Passwords already saved here are never overwritten."
    >
      <ul className="export-steps">
        {EXPORT_STEPS.map(([app, steps]) => (
          <li key={app}>
            <strong>{app}</strong>
            <span className="muted">{steps}</span>
          </li>
        ))}
      </ul>
      <div className="import-row">
        <button
          className="btn primary"
          data-testid="passwords-import"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await call<PasswordImportResult | null>('passwords.import');
              if (r) {
                setResult(r);
                setTrashed(false);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Importing...' : 'Choose CSV file...'}
        </button>
        {result ? (
          <p className={result.error ? 'warn-text' : 'ok-text'} data-testid="passwords-import-result">
            {result.error ?? importSummary(result)}
          </p>
        ) : null}
      </div>
      {result && !result.error && result.file ? (
        <div className="trash-hint" data-testid="passwords-import-trash">
          {trashed ? (
            <span>{result.file} is in the Trash. Empty the Trash to get rid of it for good.</span>
          ) : (
            <>
              <span>
                <strong>{result.file}</strong> holds your passwords in plain text. Delete it now that they are here.
              </span>
              <button className="btn small" onClick={async () => setTrashed(await call<boolean>('passwords.trashImported'))}>
                Move to Trash
              </button>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function SettingsCard({ s, update }: { s: Settings; update: Update }) {
  const p = s.passwords;
  return (
    <Card title="Settings" id="settings">
      <Row title="Offer to save passwords" hint="After you sign in to a site, the browser asks whether to keep the password. Never in private windows.">
        <Toggle label="Offer to save passwords" testId="passwords-offer" checked={p.offerToSave} onChange={(v) => void update({ passwords: { offerToSave: v } })} />
      </Row>
      <Row title="Fill passwords on websites" hint="Saved logins show up under sign-in fields. Nothing is filled until you pick one.">
        <Toggle label="Fill passwords on websites" testId="passwords-autofill" checked={p.autofill} onChange={(v) => void update({ passwords: { autofill: v } })} />
      </Row>
      <div className="row column">
        <div className="row-label">
          <span>Sites where saving is off</span>
          <small>Added when you choose Never for this site.</small>
        </div>
        {p.neverSave.length ? (
          <ul className="chips" data-testid="passwords-never">
            {p.neverSave.map((o) => (
              <li key={o}>
                {o.replace(/^https:\/\//, '')}
                <button className="chip-x" aria-label={`Offer to save passwords on ${o} again`} onClick={() => void update({ passwords: { neverSave: p.neverSave.filter((x) => x !== o) } })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">None.</span>
        )}
      </div>
    </Card>
  );
}

function Passwords() {
  const [s, update] = useSettings();
  const [data, setData] = useState<Overview | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => {
    const load = () => void call<Overview>('passwords.list').then(setData);
    load();
    return onInternalEvent((e) => e.type === 'passwords' && load());
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const all = data?.logins ?? [];
    return t ? all.filter((l) => l.host.includes(t) || l.username.toLowerCase().includes(t)) : all;
  }, [data, q]);

  if (!data || !s) return null;
  const keychainProblem = error ?? (data.keychainError ? KEYCHAIN_DENIED : null);
  return (
    <div className="page passwords">
      <div className="page-head">
        <h1>
          <Key size={24} /> Passwords
        </h1>
        <div className="head-actions">
          <button className="btn" data-testid="passwords-add" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add
          </button>
          <a className="btn" href="#import">
            Import
          </a>
          <button
            className="btn"
            data-testid="passwords-export"
            disabled={!data.logins.length}
            onClick={async () => {
              const r = await call<{ count: number } | null>('passwords.export').catch(() => null);
              if (r) setExported(`Exported ${plural(r.count, 'password', 'passwords')}. The file is not encrypted: keep it safe, and delete it when you are done.`);
            }}
          >
            Export...
          </button>
        </div>
      </div>
      <p className="lede muted">
        Saved passwords are encrypted with a key kept in your macOS Keychain, and never leave this Mac.
        {data.asksAuth ? ' Showing, copying or exporting them asks for Touch ID or your Mac password.' : ''}
      </p>
      {keychainProblem ? <p className="warn-text" data-testid="passwords-keychain-error">{keychainProblem}</p> : null}
      {exported ? <p className="ok-text">{exported}</p> : null}
      <div className="search" style={{ marginBottom: 16 }}>
        <Search />
        <input data-testid="passwords-search" placeholder="Search passwords" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <Card>
        {adding ? <AddLogin onDone={() => setAdding(false)} /> : null}
        {shown.length ? (
          <ul className="list" data-testid="login-list">
            {shown.map((l) => (
              <LoginRow key={l.id} login={l} onError={setError} />
            ))}
          </ul>
        ) : (
          <div className="empty" data-testid="passwords-empty">
            {q ? 'No saved password matches.' : 'No saved passwords yet. Sign in to a site and the browser offers to keep the password, or import them below.'}
          </div>
        )}
      </Card>
      <ImportCard />
      <SettingsCard s={s} update={update} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Passwords />);
