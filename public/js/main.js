// Dolly entry point: hash router. Each view module exports
//   mount(container: HTMLElement, params: object) => (cleanup function | Promise<cleanup function> | void)
// Routes:
//   #/            → views/home.js     (library)
//   #/record      → views/record.js   (recording setup + live recording)
//   #/edit/:id    → views/editor.js   (editor: Edit → Captions → Summary → Export)

import { applyTheme, toast } from './lib/ui.js';

const routes = [
  { pattern: /^#?\/?$/, load: () => import('./views/home.js') },
  { pattern: /^#\/record\/?$/, load: () => import('./views/record.js') },
  { pattern: /^#\/edit\/([\w-]+)\/?$/, load: () => import('./views/editor.js'), params: (m) => ({ id: m[1] }) },
];

const app = document.getElementById('app');
let cleanup = null;
let navToken = 0;

async function render() {
  const token = ++navToken;
  const hash = location.hash || '#/';
  const route = routes.find((r) => r.pattern.test(hash)) || routes[0];
  const match = hash.match(route.pattern) || [];
  const params = route.params ? route.params(match) : {};

  // Take ownership of the previous view's cleanup *before* yielding, so a newer
  // render that starts while this (possibly slow, e.g. editor flush) teardown is
  // pending can never have its own cleanup clobbered when this one resumes.
  const prev = cleanup;
  cleanup = null;
  if (typeof prev === 'function') {
    try { await prev(); } catch (err) { console.error('[router] cleanup failed', err); }
  }
  if (token !== navToken) return;

  app.replaceChildren();
  app.dataset.view = route === routes[0] ? 'home' : route === routes[1] ? 'record' : 'editor';
  window.scrollTo(0, 0);
  try {
    const mod = await route.load();
    if (token !== navToken) return;
    const next = (await mod.mount(app, params)) || null;
    if (token !== navToken) {
      // A newer navigation started while this (async) mount was pending:
      // dispose this view instead of registering it.
      if (typeof next === 'function') {
        try { await next(); } catch (err) { console.error('[router] cleanup failed', err); }
      }
      return;
    }
    cleanup = next;
  } catch (err) {
    console.error('[router] failed to mount view', err);
    if (token === navToken) app.replaceChildren(errorView(err));
  }
}

function errorView(err) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `<div class="empty-icon">!</div><h3>Something went wrong</h3><p></p><a class="btn btn-secondary" href="#/">Back to library</a>`;
  wrap.querySelector('p').textContent = err?.message || String(err);
  return wrap;
}

/** Programmatic navigation helper for views: navigate('#/edit/abc') */
export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// lib/db.js: a database upgrade waits until other Dolly tabs let go (an older tab may hold on).
let blockedNotice = null;
window.addEventListener('dolly:db-blocked', () => {
  if (!blockedNotice) blockedNotice = toast('Dolly was updated. Close or reload its other tabs to continue.', { type: 'info', duration: 0 });
});
window.addEventListener('dolly:db-unblocked', () => {
  blockedNotice?.close();
  blockedNotice = null;
});

applyTheme();
window.addEventListener('hashchange', render);
render();
