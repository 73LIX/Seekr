(function () {
  'use strict';
  const { api, session, errMsg } = H;
  const $ = (id) => document.getElementById(id);
  let mode = 'login';
  let role = 'participant';
  let codeRequired = false;

  for (const n of document.querySelectorAll('[data-sprite]')) n.append(PX.sprite(n.dataset.sprite, { scale: 4 }));
  $('logo').append(PX.sprite('chest', { scale: 3 }), 'TREASURE HUNT');
  document.addEventListener('click', (e) => { if (e.target.closest('button')) PX.sfx.play('click'); });

  function go(user) { location.replace(user.role === 'organizer' ? '/organizer.html' : '/play.html'); }

  function paint() {
    const reg = mode === 'register';
    $('title').textContent = reg ? 'Create your account' : 'Sign in';
    $('submit').textContent = reg ? 'Create account' : 'Sign in';
    $('roleSeg').classList.toggle('hidden', !reg);
    $('dnField').classList.toggle('hidden', !(reg && role === 'participant')); // organizers don't need a team display name
    $('pwHint').classList.toggle('hidden', !reg);
    $('codeField').classList.toggle('hidden', !(reg && role === 'organizer' && codeRequired));
    $('switchText').textContent = reg ? 'Already registered?' : 'New here?';
    $('switch').textContent = reg ? 'Sign in' : 'Create an account';
    $('password').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    for (const b of $('roleSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.role === role));
  }
  function showErr(msg) { const e = $('err'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }

  $('switch').addEventListener('click', (ev) => { ev.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; showErr(''); paint(); });
  $('roleSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-role]');
    if (b) { role = b.dataset.role; paint(); }
  });
  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showErr('');
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) { showErr('Enter your username and password.'); return; }
    $('submit').disabled = true;
    try {
      const body = mode === 'register'
        ? { username, password, role, display_name: role === 'participant' ? $('display').value.trim() : '', signup_code: $('signup').value }
        : { username, password };
      const out = await api('POST', mode === 'register' ? '/api/auth/register' : '/api/auth/login', body);
      session.set(out.token);
      go(out.user);
    } catch (e) {
      showErr(errMsg(e));
    } finally {
      $('submit').disabled = false;
    }
  });

  (async function init() {
    try { const c = await api('GET', '/api/config'); codeRequired = Boolean(c.organizer_code_required); } catch { /* ignore */ }
    if (location.hash === '#register') mode = 'register';
    paint();
    if (session.token()) {
      try { const { user } = await api('GET', '/api/me'); go(user); } catch { session.clear(); }
    }
  })();
})();
