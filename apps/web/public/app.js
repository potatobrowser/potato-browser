(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasIO = 'IntersectionObserver' in window;
  const timers = new WeakMap();

  // The red pen strikes a page's AI (or ads), then it folds away.
  const peel = (page, animate) => {
    clearTimeout(timers.get(page));
    if (!animate) {
      page.classList.remove('striking');
      page.dataset.peeled = 'true';
      return;
    }
    page.classList.add('striking');
    timers.set(page, setTimeout(() => (page.dataset.peeled = 'true'), 900));
  };
  const unpeel = (page) => {
    clearTimeout(timers.get(page));
    page.classList.remove('striking');
    page.dataset.peeled = 'false';
  };
  const isPeeled = (page) => page.dataset.peeled === 'true' || page.classList.contains('striking');
  const syncButton = (btn, on) => {
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('[data-shield-label]').textContent = on ? btn.dataset.on : btn.dataset.off;
  };
  const whenSeen = (el, threshold, fn) => {
    if (!hasIO) return fn(true);
    new IntersectionObserver((entries) => entries.forEach((e) => fn(e.isIntersecting)), { threshold }).observe(el);
  };

  // Hero: a window cycling through three sites, peeling each one, until the visitor takes over.
  const hero = document.querySelector('.hero-demo');
  if (hero) {
    const tabs = [...hero.querySelectorAll('[data-tab]')];
    const pages = [...hero.querySelectorAll('[data-page]')];
    const url = hero.querySelector('[data-url]');
    const shield = hero.querySelector('[data-shield]');
    const shieldOff = new Set();
    let current = pages[0];
    let auto = !reduce;
    let visible = !hasIO;
    let tick = 0;

    const sync = () => syncButton(shield, isPeeled(current));
    const select = (page) => {
      current = page;
      pages.forEach((p) => p.classList.toggle('on', p === page));
      tabs.forEach((t) => {
        const on = t.dataset.tab === page.dataset.page;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      url.textContent = page.dataset.url;
      sync();
    };
    const step = () => {
      clearTimeout(tick);
      if (!auto || !visible) return;
      if (isPeeled(current)) {
        tick = setTimeout(next, 3000);
        return;
      }
      tick = setTimeout(() => {
        peel(current, true);
        sync();
        tick = setTimeout(next, 3000);
      }, 1000);
    };
    const next = () => {
      const prev = current;
      select(pages[(pages.indexOf(current) + 1) % pages.length]);
      // Reset the page just left once it has faded out, so the next round peels it again.
      setTimeout(() => auto && unpeel(prev), 300);
      step();
    };
    const stop = () => {
      auto = false;
      clearTimeout(tick);
    };

    tabs.forEach((t) =>
      t.addEventListener('click', () => {
        stop();
        const page = pages.find((p) => p.dataset.page === t.dataset.tab);
        if (page === current) return;
        select(page);
        // The shield is on by default, so a fresh page gets peeled unless the visitor turned it off there.
        if (!isPeeled(page) && !shieldOff.has(page)) {
          tick = setTimeout(() => {
            peel(page, !reduce);
            sync();
          }, reduce ? 0 : 500);
        }
      }),
    );
    hero.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const i = tabs.indexOf(document.activeElement);
      if (!d || i < 0) return;
      e.preventDefault();
      const t = tabs[(i + d + tabs.length) % tabs.length];
      t.focus();
      t.click();
    });
    shield.addEventListener('click', () => {
      stop();
      if (isPeeled(current)) {
        unpeel(current);
        shieldOff.add(current);
      } else {
        peel(current, !reduce);
        shieldOff.delete(current);
      }
      sync();
    });

    if (reduce) {
      pages.forEach((p) => peel(p, false));
      sync();
    } else {
      whenSeen(hero, 0.3, (seen) => {
        visible = seen;
        seen ? step() : clearTimeout(tick);
      });
    }
  }

  // Ad blocker: the pen mashes each ad and strikes the trackers once the window scrolls into view.
  const ads = document.querySelector('.ads-demo');
  if (ads) {
    const page = ads.querySelector('[data-peeled]');
    const btn = ads.querySelector('[data-shield]');
    let touched = false;
    const sync = () => syncButton(btn, isPeeled(page));
    btn.addEventListener('click', () => {
      touched = true;
      isPeeled(page) ? unpeel(page) : peel(page, !reduce);
      sync();
    });
    if (reduce) {
      peel(page, false);
      sync();
    } else {
      let done = false;
      whenSeen(ads, 0.6, (seen) => {
        if (!seen || done) return;
        done = true;
        setTimeout(() => {
          if (touched) return;
          peel(page, true);
          sync();
        }, 700);
      });
    }
  }

  // Flags: the third flag tips the post over the threshold, then the chosen mode applies.
  const stage = document.querySelector('.post-stage');
  if (stage) {
    const flag = stage.querySelector('[data-flag]');
    const note = stage.querySelector('[data-mode-note]');
    const modes = [...document.querySelectorAll('[data-mode]')];
    const notes = {
      label: 'Flagged posts get an AI label.',
      hide: 'Flagged posts get buried. One click digs them up.',
      ignore: 'Nothing changes for you. You can still flag.',
    };
    let touched = false;
    const render = () => {
      const on = stage.dataset.flagged === 'true';
      flag.setAttribute('aria-pressed', String(on));
      flag.textContent = on ? 'Flagged as AI · 3' : 'AI? · 2';
      note.textContent = on ? notes[stage.dataset.flagMode] : 'Two flags so far. Press "AI?" to add the third.';
    };
    flag.addEventListener('click', () => {
      touched = true;
      stage.dataset.flagged = String(stage.dataset.flagged !== 'true');
      stage.removeAttribute('data-revealed');
      render();
    });
    stage.querySelector('[data-reveal]').addEventListener('click', () => {
      stage.dataset.revealed = '';
    });
    modes.forEach((btn) =>
      btn.addEventListener('click', () => {
        touched = true;
        modes.forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
        stage.dataset.flagMode = btn.dataset.mode;
        stage.removeAttribute('data-revealed');
        if (stage.dataset.flagged !== 'true') stage.dataset.flagged = 'true';
        render();
      }),
    );
    render();
    if (reduce) {
      stage.dataset.flagged = 'true';
      render();
    } else {
      let done = false;
      whenSeen(stage, 0.6, (seen) => {
        if (!seen || done) return;
        done = true;
        setTimeout(() => {
          if (touched) return;
          stage.dataset.flagged = 'true';
          render();
        }, 900);
      });
    }
  }

  // Release details from the download service.
  const mb = (n) => (n ? `${Math.round(n / 1048576)} MB` : '');
  fetch('/api/v1/releases/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (!info || !info.version) return;
      const sizes = info.sizes || {};
      const version = sizes.arm64 ? `Version ${info.version}, ${mb(sizes.arm64)}.` : `Version ${info.version}.`;
      const fine = document.querySelector('[data-release]');
      if (fine) fine.textContent = `Free and open source. ${version} macOS 13 or later.`;
      const sums = document.querySelector('[data-checksums]');
      if (sums && info.sha256 && info.sha256.arm64) {
        sums.textContent = `SHA-256 for version ${info.version}. Apple Silicon: ${info.sha256.arm64}. Intel: ${info.sha256.x64}.`;
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
