(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Hero demo: the red pen strikes the AI Overview, then it folds away.
  const demo = document.querySelector('.demo');
  const shield = document.querySelector('[data-shield]');
  const label = document.querySelector('[data-shield-label]');
  let timer = 0;
  const setShield = (on) => {
    shield.setAttribute('aria-pressed', String(on));
    label.textContent = on ? 'AI peeled' : 'Peel the AI';
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

  // Ad blocker demo: the pen strikes each ad, then it folds away. Runs when scrolled into view.
  const ads = document.querySelector('.ads-demo');
  const mash = document.querySelector('[data-mash]');
  const mashLabel = document.querySelector('[data-mash-label]');
  let adsTimer = 0;
  const setMash = (on) => {
    mash.setAttribute('aria-pressed', String(on));
    mashLabel.textContent = on ? 'Ads mashed' : 'Mash the ads';
  };
  const hideAds = (animate) => {
    clearTimeout(adsTimer);
    setMash(true);
    if (!animate) {
      ads.dataset.ads = 'hidden';
      return;
    }
    ads.classList.add('striking');
    adsTimer = setTimeout(() => (ads.dataset.ads = 'hidden'), 900);
  };
  const showAds = () => {
    clearTimeout(adsTimer);
    ads.classList.remove('striking');
    ads.dataset.ads = 'shown';
    setMash(false);
  };
  if (ads && mash) {
    mash.addEventListener('click', () => (ads.dataset.ads === 'hidden' ? showAds() : hideAds(!reduce)));
    if (reduce || !('IntersectionObserver' in window)) hideAds(false);
    else {
      const io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        if (mash.getAttribute('aria-pressed') === 'false') adsTimer = setTimeout(() => hideAds(true), 700);
      }, { threshold: 0.6 });
      io.observe(ads);
    }
  }

  // Flag modes.
  const notes = {
    label: 'Flagged posts stay in your feed with an AI label, like a sticker on the sack.',
    hide: 'Flagged posts get buried behind a one-line notice. One click digs them up.',
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
      const parts = [`Free, like dirt. Version ${info.version}.`];
      if (sizes.arm64) parts.push(`${mb(sizes.arm64)} download.`);
      parts.push('For Apple Silicon and Intel Macs running macOS 13 Ventura or later.');
      const fine = document.querySelector('[data-release]');
      if (fine) fine.textContent = parts.join(' ');
      const sums = document.querySelector('[data-checksums]');
      if (sums && info.sha256 && info.sha256.arm64) {
        sums.textContent = `SHA-256 checksums for version ${info.version}. Apple Silicon: ${info.sha256.arm64}. Intel: ${info.sha256.x64}.`;
        const src = info.source;
        if (src && /^[0-9a-f]{40}$/.test(src.commit) && /^https:\/\/github\.com\//.test(src.release)) {
          const a = document.createElement('a');
          a.href = src.release;
          a.textContent = `Built from commit ${src.commit.slice(0, 7)}.`;
          sums.append(' ', a);
        }
        sums.hidden = false;
      }
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
        el.textContent = `${s.flaggedPosts.toLocaleString('en-US')} AI-generated ${s.flaggedPosts === 1 ? 'post' : 'posts'} spotted and flagged so far.`;
      }
    })
    .catch(() => {});
})();
