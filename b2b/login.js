// login.js (B2B login page)

const API_URL = 'https://booking-system-production-fa13.up.railway.app';

document.getElementById('loginBtn').addEventListener('click', doLogin);

['loginEmail', 'loginPassword'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

// if the dashboard sent us here (expired session, password change),
// explain why rather than dumping the user on a blank login form
const redirectMessage = new URLSearchParams(window.location.search).get('msg');
if (redirectMessage) {
  document.getElementById('loginMessage').innerHTML =
    `<div class="message-box message-notice"></div>`;
  document.querySelector('#loginMessage .message-box').textContent = redirectMessage;
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const messageBox = document.getElementById('loginMessage');
  const button = document.getElementById('loginBtn');

  if (!email || !password) {
    messageBox.innerHTML = '<div class="message-box message-error">Enter your email and password.</div>';
    return;
  }

  button.disabled = true;
  button.textContent = 'Checking...';

  try {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok) {
      // The token is what proves who we are on every later request.
      // sessionStorage, not localStorage: it dies with the tab, so a
      // shared machine doesn't leave a live session behind.
      sessionStorage.setItem('token', data.token);
      sessionStorage.setItem('company', JSON.stringify(data.company));
      window.location.href = 'dashboard.html';
      return;
    }

    messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not log in.'}</div>`;

  } catch (err) {
    console.error(err);
    messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
  }

  button.disabled = false;
  button.textContent = 'Log in';
}
