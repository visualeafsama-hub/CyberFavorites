const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.has('expired')) $('msg').textContent = '这个登录链接已经用过或者过期了，请重新生成一个。';

fetch('/api/auth/status').then((r) => r.json()).then((s) => { if (s.loggedIn) location.replace('/'); });

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('code').value.trim() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    location.replace('/');
  } catch (err) {
    $('msg').textContent = err.message;
    $('msg').classList.add('err');
  } finally { btn.disabled = false; }
});
