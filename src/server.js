import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { query, getTodayQuotaUsage } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token');
  if (!config.adminToken || token !== config.adminToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// 現在ライブ中（VTuber以外・同接数が少ない順）の配信一覧
app.get('/api/streams', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const { rows } = await query(
      `SELECT l.video_id, l.title, l.thumbnail_url, l.concurrent_viewers, l.started_at, l.last_checked_at,
              c.channel_id, c.channel_title, c.thumbnail_url AS channel_thumbnail_url
       FROM live_status l
       JOIN channels c ON c.channel_id = l.channel_id
       WHERE l.is_live = true AND c.status = 'active'
         AND (l.concurrent_viewers IS NULL OR l.concurrent_viewers < $2)
       ORDER BY (l.concurrent_viewers IS NULL) ASC, l.concurrent_viewers ASC, l.last_checked_at DESC
       LIMIT $1`,
      [limit, config.maxConcurrentViewers]
    );

    const streams = rows.map((r) => ({
      videoId: r.video_id,
      url: `https://www.youtube.com/watch?v=${r.video_id}`,
      title: r.title,
      thumbnailUrl: r.thumbnail_url,
      concurrentViewers: r.concurrent_viewers,
      startedAt: r.started_at,
      lastCheckedAt: r.last_checked_at,
      channel: {
        id: r.channel_id,
        title: r.channel_title,
        thumbnailUrl: r.channel_thumbnail_url,
        url: `https://www.youtube.com/channel/${r.channel_id}`,
      },
    }));

    res.json({ streams });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// 全体の統計・クォータ利用状況
app.get('/api/stats', async (req, res) => {
  try {
    const [{ rows: liveCountRows }, { rows: channelCountRows }, quotaUsed] = await Promise.all([
      query(
        `SELECT count(*)::int AS c FROM live_status
         WHERE is_live = true AND (concurrent_viewers IS NULL OR concurrent_viewers < $1)`,
        [config.maxConcurrentViewers]
      ),
      query("SELECT status, count(*)::int AS c FROM channels GROUP BY status"),
      getTodayQuotaUsage(),
    ]);

    const channelsByStatus = Object.fromEntries(channelCountRows.map((r) => [r.status, r.c]));

    res.json({
      liveNow: liveCountRows[0]?.c ?? 0,
      channels: channelsByStatus,
      quota: { usedToday: quotaUsed, dailyLimit: config.quotaDailyLimit },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// チャンネルの追加/除外リクエストを受け付ける（一般ユーザー向け）
app.post('/api/requests', async (req, res) => {
  try {
    const { channelUrl, channelId, type, note } = req.body || {};
    if (!['add', 'remove'].includes(type)) {
      return res.status(400).json({ error: 'type must be "add" or "remove"' });
    }
    if (!channelUrl && !channelId) {
      return res.status(400).json({ error: 'channelUrl or channelId is required' });
    }

    await query(
      `INSERT INTO requests (channel_id, channel_url, type, note) VALUES ($1, $2, $3, $4)`,
      [channelId || null, channelUrl || null, type, note || null]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- 管理API（ADMIN_TOKEN必須） ---

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  const { rows } = await query('SELECT * FROM requests WHERE status = $1 ORDER BY created_at ASC', [status]);
  res.json({ requests: rows });
});

app.post('/api/admin/requests/:id/resolve', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { action } = req.body || {}; // 'approve' | 'reject'
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "reject"' });
  }

  const { rows } = await query('SELECT * FROM requests WHERE id = $1', [id]);
  const reqRow = rows[0];
  if (!reqRow) return res.status(404).json({ error: 'not_found' });

  if (action === 'approve' && reqRow.channel_id) {
    if (reqRow.type === 'add') {
      await query(
        `INSERT INTO channels (channel_id, channel_title, status)
         VALUES ($1, $1, 'active')
         ON CONFLICT (channel_id) DO UPDATE SET status = 'active', exclude_reason = NULL`,
        [reqRow.channel_id]
      );
    } else if (reqRow.type === 'remove') {
      await query(
        `INSERT INTO channels (channel_id, channel_title, status, exclude_reason)
         VALUES ($1, $1, 'excluded', '手動申請による除外')
         ON CONFLICT (channel_id) DO UPDATE SET status = 'excluded', exclude_reason = '手動申請による除外'`,
        [reqRow.channel_id]
      );
      await query('UPDATE live_status SET is_live = false WHERE channel_id = $1', [reqRow.channel_id]);
    }
  }

  await query("UPDATE requests SET status = $2, resolved_at = now() WHERE id = $1", [
    id,
    action === 'approve' ? 'approved' : 'rejected',
  ]);

  res.json({ ok: true });
});

// 管理用: 手動でバッチを1回叩く（デプロイ直後の動作確認用）
app.post('/api/admin/run/discovery', requireAdmin, async (req, res) => {
  const { runDiscovery } = await import('./discovery.js');
  const result = await runDiscovery();
  res.json(result);
});

app.post('/api/admin/run/monitor', requireAdmin, async (req, res) => {
  const { runMonitor } = await import('./monitor.js');
  const result = await runMonitor();
  res.json(result);
});

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
});
