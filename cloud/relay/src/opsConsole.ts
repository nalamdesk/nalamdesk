// The ops console page (#154): one static page served by the relay at
// /ops. It signs staff in through the Cognito ops pool's managed login
// (authorization code with PKCE, MFA required by the pool) and calls
// /ops/api/* with the access token. All data is written with textContent,
// never as HTML.

export const OPS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>NalamDesk ops</title>
<link rel="stylesheet" href="/ops/app.css">
<script src="/ops/app.js" defer></script>
</head>
<body>
<header>
  <h1>NalamDesk ops</h1>
  <span id="who"></span>
  <button id="signout" type="button" hidden>Sign out</button>
</header>
<main>
  <p id="status" role="status"></p>

  <section aria-labelledby="requests-title">
    <div class="row">
      <h2 id="requests-title">Pairing requests</h2>
      <button id="refresh" type="button">Refresh</button>
    </div>
    <p class="hint">Approve only after you have checked the facility in HFR and linked it to the bridge in ABDM. Read the code only to the contact registered in HFR.</p>
    <table>
      <thead><tr><th>HFR ID</th><th>Device</th><th>Key</th><th>Requested</th><th>Status</th><th></th></tr></thead>
      <tbody id="requests"></tbody>
    </table>
    <p id="requests-empty" class="hint" hidden>No pending requests.</p>
  </section>

  <section aria-labelledby="devices-title">
    <h2 id="devices-title">Devices</h2>
    <form id="lookup" class="row">
      <label for="hip">HFR ID</label>
      <input id="hip" name="hip" placeholder="IN2710000123" autocomplete="off" pattern="IN[0-9]{10}" required>
      <button type="submit">Look up</button>
    </form>
    <table>
      <thead><tr><th>Device</th><th>Name</th><th>Status</th><th>Paired</th><th>Approved by</th><th></th></tr></thead>
      <tbody id="devices"></tbody>
    </table>
  </section>
</main>

<dialog id="approve-dialog">
  <form method="dialog" id="approve-form">
    <h2>Approve <span id="approve-hfr"></span></h2>
    <p>Key <strong id="approve-key"></strong>, <span id="approve-label"></span></p>
    <label><input type="checkbox" required> I checked this facility in HFR.</label>
    <label><input type="checkbox" required> It is linked to the NalamDesk bridge in ABDM.</label>
    <label><input type="checkbox" required> I will read the code only to the contact registered in HFR.</label>
    <div class="row end">
      <button value="cancel" formnovalidate>Cancel</button>
      <button value="approve" class="primary">Approve and show code</button>
    </div>
  </form>
</dialog>

<dialog id="code-dialog">
  <form method="dialog">
    <h2>Pairing code</h2>
    <p class="code" id="code"></p>
    <p>For <span id="code-hfr"></span>. Valid until <span id="code-expiry"></span>, single use. It is not shown again.</p>
    <div class="row end"><button class="primary">Done</button></div>
  </form>
</dialog>
</body>
</html>
`;

export const OPS_CSS = `:root { color-scheme: light dark; --fg: #1d2327; --muted: #5b6770; --line: #d9dee2; --bg: #ffffff; --accent: #0b6e4f; --danger: #b42318; }
@media (prefers-color-scheme: dark) { :root { --fg: #e7ecef; --muted: #9aa6ae; --line: #36414a; --bg: #14191d; --accent: #3fb68b; --danger: #f97066; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; gap: 16px; align-items: center; padding: 12px 24px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 17px; margin: 0; flex: 1; }
main { max-width: 1040px; margin: 0 auto; padding: 16px 24px 48px; }
h2 { font-size: 16px; margin: 0; }
section { margin-top: 28px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.row.end { justify-content: flex-end; margin-top: 16px; }
section > .row { justify-content: space-between; }
.hint { color: var(--muted); margin: 6px 0 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
td.mono, .mono { font-family: ui-monospace, monospace; font-size: 13px; }
button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--danger); border-color: var(--danger); }
input { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
dialog { border: 1px solid var(--line); border-radius: 10px; padding: 20px 24px; max-width: 460px; color: var(--fg); background: var(--bg); }
dialog label { display: block; margin: 8px 0; }
.code { font: 600 32px/1.2 ui-monospace, monospace; letter-spacing: 3px; margin: 12px 0; }
#status:empty { display: none; }
#status { padding: 8px 12px; border-radius: 6px; border: 1px solid var(--line); }
`;

export const OPS_JS = `'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const store = window.sessionStorage;
  let config = null;

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => location.origin + '/ops/';
  const say = (text) => { $('status').textContent = text || ''; };
  const when = (ms) => new Date(ms).toLocaleString();

  async function signIn() {
    const verifier = random(48);
    const state = random(16);
    store.setItem('ops.verifier', verifier);
    store.setItem('ops.state', state);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = new URL('https://' + config.authDomain + '/oauth2/authorize');
    url.search = new URLSearchParams({
      response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri(), scope: 'openid',
      code_challenge_method: 'S256', code_challenge: challenge, state
    }).toString();
    location.assign(url.toString());
  }

  async function finishSignIn(params) {
    const expected = store.getItem('ops.state');
    const verifier = store.getItem('ops.verifier');
    store.removeItem('ops.state');
    store.removeItem('ops.verifier');
    history.replaceState(null, '', '/ops/');
    if (!expected || params.get('state') !== expected || !verifier) throw new Error('Sign-in did not match; try again.');
    const res = await fetch('https://' + config.authDomain + '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: config.clientId, code: params.get('code'),
        redirect_uri: redirectUri(), code_verifier: verifier
      })
    });
    if (!res.ok) throw new Error('Sign-in failed.');
    const tokens = await res.json();
    store.setItem('ops.token', tokens.access_token);
    store.setItem('ops.expires', String(Date.now() + (tokens.expires_in - 60) * 1000));
  }

  function token() {
    const value = store.getItem('ops.token');
    return value && Number(store.getItem('ops.expires')) > Date.now() ? value : null;
  }

  function signOut() {
    store.clear();
    const url = new URL('https://' + config.authDomain + '/logout');
    url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() }).toString();
    location.assign(url.toString());
  }

  async function api(method, path, body) {
    const res = await fetch('/ops/api' + path, {
      method,
      headers: { authorization: 'Bearer ' + token(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { store.removeItem('ops.token'); await signIn(); throw new Error('Signing in again.'); }
    const data = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  function cell(row, text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function button(td, text, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (className) b.className = className;
    b.addEventListener('click', onClick);
    td.appendChild(b);
    return b;
  }

  async function loadRequests() {
    const { requests } = await api('GET', '/pairing-requests');
    const body = $('requests');
    body.replaceChildren();
    $('requests-empty').hidden = requests.length > 0;
    for (const r of requests) {
      const row = document.createElement('tr');
      cell(row, r.hfrId, 'mono');
      cell(row, r.label + (r.appVersion ? ' (' + r.appVersion + ')' : ''));
      cell(row, r.keyFingerprint, 'mono');
      cell(row, when(r.createdAt));
      cell(row, r.status === 'approved' ? 'Code sent' : 'Waiting');
      const actions = cell(row, '');
      actions.className = 'row';
      button(actions, r.status === 'approved' ? 'New code' : 'Approve', 'primary', () => approve(r));
      button(actions, 'Reject', 'danger', () => reject(r));
      body.appendChild(row);
    }
  }

  function approve(r) {
    $('approve-hfr').textContent = r.hfrId;
    $('approve-key').textContent = r.keyFingerprint;
    $('approve-label').textContent = r.label;
    $('approve-form').reset();
    const dialog = $('approve-dialog');
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'approve') return;
      try {
        const result = await api('POST', '/pairing-requests/' + encodeURIComponent(r.hfrId) + '/approve', { requestId: r.requestId });
        $('code').textContent = result.code;
        $('code-hfr').textContent = r.hfrId;
        $('code-expiry').textContent = new Date(result.expiresAt).toLocaleTimeString();
        $('code-dialog').showModal();
        await loadRequests();
      } catch (error) { say(error.message); }
    };
    dialog.showModal();
  }

  async function reject(r) {
    if (!confirm('Reject the pairing request for ' + r.hfrId + '?')) return;
    try { await api('POST', '/pairing-requests/' + encodeURIComponent(r.hfrId) + '/reject', { requestId: r.requestId }); await loadRequests(); }
    catch (error) { say(error.message); }
  }

  async function loadDevices(hipId) {
    const { devices } = await api('GET', '/devices?hipId=' + encodeURIComponent(hipId));
    const body = $('devices');
    body.replaceChildren();
    for (const d of devices) {
      const row = document.createElement('tr');
      cell(row, d.deviceId, 'mono');
      cell(row, d.label);
      cell(row, d.status === 'active' ? 'Active' : 'Revoked' + (d.revokedReason === 'replaced' ? ' (replaced)' : ''));
      cell(row, when(d.pairedAt));
      cell(row, d.approvedBy);
      const actions = cell(row, '');
      if (d.status === 'active') {
        button(actions, 'Revoke', 'danger', async () => {
          if (!confirm('Revoke ' + d.deviceId + '? The clinic will have to pair again.')) return;
          try { await api('POST', '/devices/' + encodeURIComponent(d.deviceId) + '/revoke'); await loadDevices(hipId); }
          catch (error) { say(error.message); }
        });
      }
      body.appendChild(row);
    }
    if (!devices.length) say('No devices for ' + hipId + '.');
  }

  async function start() {
    config = await (await fetch('/ops/config.json')).json();
    const params = new URLSearchParams(location.search);
    if (params.has('code')) await finishSignIn(params);
    if (!token()) return signIn();
    $('signout').hidden = false;
    $('signout').addEventListener('click', signOut);
    $('refresh').addEventListener('click', () => loadRequests().catch((e) => say(e.message)));
    $('lookup').addEventListener('submit', (event) => {
      event.preventDefault();
      say('');
      loadDevices($('hip').value.trim().toUpperCase()).catch((e) => say(e.message));
    });
    await loadRequests();
  }

  start().catch((error) => say(error.message));
})();
`;
