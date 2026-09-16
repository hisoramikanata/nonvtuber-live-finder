const grid = document.getElementById('grid');
const loading = document.getElementById('loading');
const empty = document.getElementById('empty');
const statsEl = document.getElementById('stats');

function formatViewers(n) {
  if (n === null || n === undefined) return '取得待ち';
  return `${n.toLocaleString()}人視聴中`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前から`;
  const hr = Math.floor(min / 60);
  return `${hr}時間前から`;
}

function renderCard(stream) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = stream.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const low = stream.concurrentViewers !== null && stream.concurrentViewers <= 10;

  if (stream.isPinned) a.classList.add('pinned');

  a.innerHTML = `
    <div class="thumb-wrap">
      <img src="${stream.thumbnailUrl || ''}" alt="" loading="lazy" />
      <span class="viewers-badge ${low ? 'low' : ''}">${formatViewers(stream.concurrentViewers)}</span>
      ${stream.isPinned ? '<span class="pinned-badge">📌 注目</span>' : ''}
    </div>
    <div class="card-body">
      <p class="card-title">${escapeHtml(stream.title || '')}</p>
      <p class="card-channel">${escapeHtml(stream.channel.title)} ・ ${timeAgo(stream.startedAt)}配信中</p>
    </div>
  `;
  return a;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadStreams() {
  try {
    const res = await fetch('/api/streams');
    const data = await res.json();
    loading.hidden = true;

    grid.innerHTML = '';
    if (!data.streams || data.streams.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const stream of data.streams) {
      grid.appendChild(renderCard(stream));
    }
  } catch (err) {
    loading.textContent = '読み込みに失敗しました。しばらくしてから再読み込みしてください。';
    console.error(err);
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    statsEl.innerHTML = `
      <span>配信中: ${data.liveNow}件</span>
      <span>登録チャンネル: ${data.channels.active || 0}件</span>
      <span>本日のAPI利用: ${data.quota.usedToday}/${data.quota.dailyLimit} units</span>
    `;
  } catch (err) {
    console.error(err);
  }
}

document.getElementById('request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const channelUrl = document.getElementById('channel-url').value;
  const type = document.getElementById('request-type').value;
  const note = document.getElementById('note').value;
  const resultEl = document.getElementById('request-result');

  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelUrl, type, note }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('request failed');
    resultEl.textContent = data.message || '送信しました。ご協力ありがとうございます。';
    e.target.reset();
    if (data.status === 'approved') {
      loadStreams();
      loadStats();
    }
  } catch (err) {
    resultEl.textContent = '送信に失敗しました。時間をおいて再試行してください。';
  }
});

loadStreams();
loadStats();
setInterval(loadStreams, 60_000);
setInterval(loadStats, 60_000);
