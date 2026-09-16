function getToken() {
  return document.getElementById('admin-token').value;
}

function showResult(msg) {
  document.getElementById('result').textContent = msg;
}

async function loadRequests() {
  const token = getToken();
  const res = await fetch('/api/admin/requests?status=pending', {
    headers: { 'x-admin-token': token },
  });
  if (!res.ok) {
    showResult('認証に失敗しました。トークンを確認してください。');
    return;
  }
  const data = await res.json();
  const tbody = document.getElementById('req-body');
  tbody.innerHTML = '';
  document.getElementById('req-table').hidden = false;

  if (data.requests.length === 0) {
    showResult('未対応のリクエストはありません。');
  } else {
    showResult('');
  }

  for (const r of data.requests) {
    const tr = document.createElement('tr');
    const channelLabel = r.channel_title
      ? `${r.channel_title}${r.channel_id ? ` (${r.channel_id})` : ''}`
      : r.channel_url || r.channel_id || '（未解決）';
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.type === 'add' ? '追加' : '除外'}</td>
      <td>${channelLabel}${r.channel_url && r.channel_title ? `<br><small>${r.channel_url}</small>` : ''}</td>
      <td>${r.note || ''}</td>
      <td>
        <button data-action="approve" data-id="${r.id}">承認</button>
        <button data-action="reject" data-id="${r.id}">却下</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const res = await fetch(`/api/admin/requests/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        loadRequests();
      } else {
        const data = await res.json().catch(() => ({}));
        showResult(data.message || '処理に失敗しました。');
      }
    });
  });
}

document.getElementById('load-btn').addEventListener('click', loadRequests);

document.getElementById('run-discovery').addEventListener('click', async () => {
  showResult('発見バッチを実行中…');
  const res = await fetch('/api/admin/run/discovery', {
    method: 'POST',
    headers: { 'x-admin-token': getToken() },
  });
  const data = await res.json();
  showResult(`発見バッチ結果: ${JSON.stringify(data)}`);
});

document.getElementById('run-monitor').addEventListener('click', async () => {
  showResult('監視バッチを実行中…');
  const res = await fetch('/api/admin/run/monitor', {
    method: 'POST',
    headers: { 'x-admin-token': getToken() },
  });
  const data = await res.json();
  showResult(`監視バッチ結果: ${JSON.stringify(data)}`);
});

document.getElementById('check-token').addEventListener('click', async () => {
  const res = await fetch('/api/admin/token-check', {
    headers: { 'x-admin-token': getToken() },
  });
  const data = await res.json();
  showResult(`トークン診断: ${JSON.stringify(data)}`);
});

document.getElementById('run-migrate').addEventListener('click', async () => {
  showResult('マイグレーション実行中…');
  const res = await fetch('/api/admin/migrate', {
    method: 'POST',
    headers: { 'x-admin-token': getToken() },
  });
  const data = await res.json();
  showResult(`マイグレーション結果: ${JSON.stringify(data)}`);
});

document.getElementById('run-ensure-pinned').addEventListener('click', async () => {
  showResult('ピン留めチャンネル登録中…');
  const res = await fetch('/api/admin/run/ensure-pinned', {
    method: 'POST',
    headers: { 'x-admin-token': getToken() },
  });
  const data = await res.json();
  showResult(`ピン留め登録結果: ${JSON.stringify(data)}`);
});
