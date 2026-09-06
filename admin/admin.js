// admin.js (Admin Portal — shared by admin-login.html and admin-dashboard.html)
// Each half below only wires itself up if that page's elements exist,
// so this one file works correctly no matter which page loaded it.

const API_URL = 'http://booking-system-production-fa13.up.railway.app';

// ================================================================
// LOGIN PAGE
// ================================================================
if (document.getElementById('loginBtn')) {
  document.getElementById('loginBtn').addEventListener('click', doLogin);

  ['loginEmail', 'loginPassword'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });

  const redirectMessage = new URLSearchParams(window.location.search).get('msg');
  if (redirectMessage) {
    document.getElementById('loginMessage').innerHTML =
      `<div class="message-box message-error">${redirectMessage}</div>`;
  }
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
    const response = await fetch(`${API_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok) {
      sessionStorage.setItem('adminToken', data.token);
      sessionStorage.setItem('admin', JSON.stringify(data.admin));
      // matches this project's actual filename — not "dashboard.html"
      window.location.href = 'admin-dashboard.html';
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

// ================================================================
// DASHBOARD PAGE
// ================================================================
if (document.getElementById('companyGrid')) {

  const adminToken = sessionStorage.getItem('adminToken');
  const admin = JSON.parse(sessionStorage.getItem('admin') || 'null');

  if (!adminToken || !admin) {
    window.location.replace('admin-login.html');
  }

  let allCompanies = [];
  let editingCompanyId = null;

  async function api(path, options = {}) {
    const headers = { Authorization: `Bearer ${adminToken}`, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${API_URL}${path}`, { ...options, headers });

    if (response.status === 401) {
      signOut('Your session ended. Please log in again.');
      throw new Error('Unauthorised');
    }

    return response;
  }

  function signOut(message) {
    sessionStorage.removeItem('adminToken');
    sessionStorage.removeItem('admin');
    window.location.replace('admin-login.html' + (message ? '?msg=' + encodeURIComponent(message) : ''));
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  document.getElementById('logoutBtn').addEventListener('click', () => signOut());

  document.getElementById('addCompanyBtn').addEventListener('click', () => openCompanyModal(null));
  document.getElementById('companyModalClose').addEventListener('click', closeCompanyModal);
  document.getElementById('companyModalCancel').addEventListener('click', closeCompanyModal);
  document.getElementById('companyModal').addEventListener('click', e => {
    if (e.target.id === 'companyModal') closeCompanyModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('companyModal').hidden) closeCompanyModal();
  });

  document.getElementById('companyForm').addEventListener('submit', saveCompany);

  loadCompanies();

  async function loadCompanies() {
    const grid = document.getElementById('companyGrid');
    try {
      const res = await api('/api/admin/companies');
      const data = await res.json();
      allCompanies = data.companies || [];
      renderCompanies();
    } catch (err) {
      console.error(err);
      grid.innerHTML = '<p class="empty-note">Could not load companies. Is the server running?</p>';
    }
  }

  function renderCompanies() {
    const grid = document.getElementById('companyGrid');
    const emptyNote = document.getElementById('emptyNote');

    emptyNote.hidden = allCompanies.length > 0;
    grid.innerHTML = allCompanies.map(c => {
      const created = c.created_at ? new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return `
        <div class="company-card">
          <div class="company-card-head">
            <div>
              <h3>${escapeHtml(c.company_name)}</h3>
              <div class="company-email">${escapeHtml(c.email)}</div>
            </div>
            <span class="mode-pill${c.scheduling_mode === 'hour' ? ' hour' : ''}">${c.scheduling_mode === 'hour' ? 'Hours' : 'Day'}</span>
          </div>
          <div class="company-meta">
            <strong>${escapeHtml(c.phone || '\u2014')}</strong> &middot; ${escapeHtml(c.whatsapp || 'no WhatsApp')}<br>
            ${escapeHtml(c.address || 'No address on file')}<br>
            ${c.pricing_mode === 'per_night' ? 'Per night' : 'Per day'} pricing &middot; ${escapeHtml(c.currency || '$')} &middot; joined ${created}
          </div>
          <div class="company-card-actions">
            <button type="button" class="edit-btn" data-id="${c.id}">Edit</button>
            <button type="button" class="delete-btn" data-id="${c.id}" data-name="${escapeHtml(c.company_name)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const company = allCompanies.find(c => String(c.id) === btn.dataset.id);
        if (company) openCompanyModal(company);
      });
    });

    grid.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteCompany(btn.dataset.id, btn.dataset.name));
    });
  }

  function openCompanyModal(company) {
    editingCompanyId = company ? company.id : null;

    document.getElementById('companyModalTitle').textContent = company ? `Edit ${company.company_name}` : 'Add a company';
    document.getElementById('companyModalSave').textContent = company ? 'Save changes' : 'Add company';
    document.getElementById('passwordHint').textContent = company ? '(leave blank to keep the current password)' : '(at least 6 characters)';
    document.getElementById('fPassword').required = !company;
    document.getElementById('companyFormMessage').innerHTML = '';

    document.getElementById('fCompanyName').value = company ? company.company_name : '';
    document.getElementById('fEmail').value = company ? company.email : '';
    document.getElementById('fPassword').value = '';
    document.getElementById('fPhone').value = company ? (company.phone || '') : '';
    document.getElementById('fWhatsapp').value = company ? (company.whatsapp || '') : '';
    document.getElementById('fAddress').value = company ? (company.address || '') : '';
    document.getElementById('fPricingMode').value = company ? company.pricing_mode : 'per_day';
    document.getElementById('fSchedulingMode').value = company ? company.scheduling_mode : 'day';
    document.getElementById('fCurrency').value = company ? company.currency : '$';

    document.getElementById('companyModal').hidden = false;
    document.getElementById('fCompanyName').focus();
  }

  function closeCompanyModal() {
    document.getElementById('companyModal').hidden = true;
    editingCompanyId = null;
  }

  async function saveCompany(e) {
    e.preventDefault();

    const messageBox = document.getElementById('companyFormMessage');
    const saveBtn = document.getElementById('companyModalSave');

    const payload = {
      company_name: document.getElementById('fCompanyName').value.trim(),
      email: document.getElementById('fEmail').value.trim(),
      phone: document.getElementById('fPhone').value.trim(),
      whatsapp: document.getElementById('fWhatsapp').value.replace(/\D/g, ''),
      address: document.getElementById('fAddress').value.trim(),
      pricing_mode: document.getElementById('fPricingMode').value,
      scheduling_mode: document.getElementById('fSchedulingMode').value,
      currency: document.getElementById('fCurrency').value.trim() || '$'
    };

    const password = document.getElementById('fPassword').value;
    if (password) payload.password = password;

    if (!payload.company_name || !payload.email) {
      messageBox.innerHTML = '<div class="message-box message-error">Company name and email are required.</div>';
      return;
    }
    if (!editingCompanyId && !password) {
      messageBox.innerHTML = '<div class="message-box message-error">Choose a password for this company.</div>';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = editingCompanyId ? 'Saving...' : 'Adding...';

    try {
      const res = editingCompanyId
        ? await api(`/api/admin/companies/${editingCompanyId}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/admin/companies', { method: 'POST', body: JSON.stringify(payload) });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not save this company.'}</div>`;
        saveBtn.disabled = false;
        saveBtn.textContent = editingCompanyId ? 'Save changes' : 'Add company';
        return;
      }

      closeCompanyModal();
      await loadCompanies();
    } catch (err) {
      console.error(err);
      messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
      saveBtn.disabled = false;
      saveBtn.textContent = editingCompanyId ? 'Save changes' : 'Add company';
    }
  }

  async function deleteCompany(id, name) {
    if (!confirm(`Delete "${name}"? This permanently removes all of their products, images, and bookings too. There's no undo.`)) return;

    try {
      const res = await api(`/api/admin/companies/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not delete that company.');
        return;
      }
      await loadCompanies();
    } catch (err) {
      console.error(err);
      alert('Could not connect to server.');
    }
  }
}