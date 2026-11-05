import { createRoot } from 'react-dom/client';
import '../shared/pages.css';

function ErrorPage() {
  const params = new URLSearchParams(location.search);
  const url = params.get('url') ?? '';
  const reason = params.get('reason') ?? 'crashed';
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  const title = reason === 'crashed' ? 'This tab crashed' : "This page isn't available";
  return (
    <main className="page" style={{ maxWidth: 560, paddingTop: '14vh' }}>
      <h1 style={{ fontSize: 26, marginBottom: 10 }}>{title}</h1>
      <p className="muted">{reason === 'crashed' ? `Something went wrong while showing ${host || 'this page'}.` : `${host} could not be shown.`}</p>
      {url && /^https?:/.test(url) ? (
        <button className="btn primary" style={{ marginTop: 18 }} onClick={() => (location.href = url)}>
          Reload {host}
        </button>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<ErrorPage />);
