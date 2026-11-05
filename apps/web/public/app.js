(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Hero demo: the red pen strikes the AI Overview, then it folds away.
  const demo = document.querySelector('.demo');
  const shield = document.querySelector('[data-shield]');
  const label = document.querySelector('[data-shield-label]');
  let timer = 0;
  const setShield = (on) => {
    shield.setAttribute('aria-pressed', String(on));
    label.textContent = on ? 'AI hidden' : 'Hide AI';
  };
  const hideAi = (animate) => {
    clearTimeout(timer);
    setShield(true);
    if (!animate) {
      demo.dataset.ai = 'hidden';
      return;
    }
    demo.classList.add('striking');
    timer = setTimeout(() => (demo.dataset.ai = 'hidden'), 900);
  };
  const showAi = () => {
    clearTimeout(timer);
    demo.classList.remove('striking');
    demo.dataset.ai = 'shown';
    setShield(false);
  };
  if (demo && shield) {
    shield.addEventListener('click', () => (demo.dataset.ai === 'hidden' ? showAi() : hideAi(!reduce)));
    if (reduce) hideAi(false);
    else setTimeout(() => hideAi(true), 1100);
  }

  // Flag modes.
  const notes = {
    label: 'Flagged posts stay in your feed with a visible AI label.',
    hide: 'Flagged posts fold away behind a one-line notice you can open.',
    ignore: 'Nothing changes for you. You can still flag posts for everyone else.',
  };
  const stage = document.querySelector('.post-stage');
  const note = document.querySelector('[data-mode-note]');
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      stage.dataset.flagMode = btn.dataset.mode;
      note.textContent = notes[btn.dataset.mode];
    });
  });

  // Release details from the download service.
  const mb = (n) => (n ? `${Math.round(n / 1048576)} MB` : '');
  fetch('/api/v1/releases/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (!info || !info.version) return;
      const sizes = info.sizes || {};
      const parts = [`Free. Version ${info.version}.`];
      if (sizes.arm64) parts.push(`${mb(sizes.arm64)} download.`);
      parts.push('For Apple Silicon and Intel Macs running macOS 13 Ventura or later.');
      const fine = document.querySelector('[data-release]');
      if (fine) fine.textContent = parts.join(' ');
      document.querySelectorAll('[data-download]').forEach((a) => {
        const size = sizes[a.dataset.download];
        if (size) a.title = `${mb(size)}, version ${info.version}`;
      });
    })
    .catch(() => {});

  fetch('/api/v1/stats')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      const el = document.querySelector('[data-stats]');
      if (el && s && s.flaggedPosts > 0) {
        el.textContent = `${s.flaggedPosts.toLocaleString('en-US')} posts flagged as AI-generated so far.`;
      }
    })
    .catch(() => {});
})();
