import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { query, getTodayQuotaUsage, addQuotaUsage } from './db.js';
import { resolveChannel } from './youtube.js';
import { classify } from './vtuberFilter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// チャンネルURL/ハンドル名/ID等からチャンネル情報を解決する（失敗時はnullを返し、呼び出し元で処理を継続させる）
async function tryResolveChannel(input) {
  if (!input) return null;
  try {
    const { item, quotaUsed } = await resolveChannel(input);
    if (quotaUsed) await addQuotaUsage(quotaUsed);
    return item;
  } catch (err) {
    console.error('[resolveChannel] failed:', err.message);
    return null;
  }
}

// チャンネルをactive/excludedとして確定させる（channels・live_statusへの反映）
async function applyChannelDecision(channelId, channelTitle, decision, reason) {
  if (decision === 'active') {
    await query(
      `INSERT INTO channels (channel_id, channel_title, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (channel_id) DO UPDATE SET status = 'active', exclude_reason = NULL, channel_title = EXCLUDED.channel_title`,
      [channelId, channelTitle || channelId]
    );
  } else {
    await query(
      `INSERT INTO channels (channel_id, channel_title, status, exclude_reason)
       VALUES ($1, $2, 'excluded', $3)
       ON CONFLICT (channel_id) DO UPDATE SET status = 'excluded', exclude_reason = EXCLUDED.exclude_reason`,
      [channelId, channelTitle || channelId, reason || null]
    );
    await query('UPDATE live_status SET is_live = false WHERE channel_id = $1', [channelId]);
  }
}

// ADMIN_TOKENがRailway側にきちんと設定されているかを値を晒さずに確認するための診断用エンドポイント
app.get('/api/admin/token-check', (req, res) => {
  const sentToken = req.header('x-admin-token') || '';
  res.json({
    adminTokenConfigured: Boolean(config.adminToken),
    adminTokenLength: config.adminToken.length,
    sentTokenLength: sentToken.length,
    matches: Boolean(config.adminToken) && sentToken === config.adminToken,
  });
});

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
              c.channel_id, c.channel_title, c.thumbnail_url AS channel_thumbnail_url, c.is_pinned
       FROM live_status l
       JOIN channels c ON c.channel_id = l.channel_id
       WHERE l.is_live = true AND c.status = 'active'
         AND (c.is_pinned OR l.concurrent_viewers IS NULL OR l.concurrent_viewers < $2)
         AND (l.started_at IS NULL OR l.started_at > now() - ($3 * interval '1 hour'))
       ORDER BY c.is_pinned DESC, (l.concurrent_viewers IS NULL) ASC, l.concurrent_viewers ASC, l.last_checked_at DESC
       LIMIT $1`,
      [limit, config.maxConcurrentViewers, config.maxLiveHours]
    );

    const streams = rows.map((r) => ({
      videoId: r.video_id,
      url: `https://www.youtube.com/watch?v=${r.video_id}`,
      title: r.title,
      thumbnailUrl: r.thumbnail_url,
      concurrentViewers: r.concurrent_viewers,
      startedAt: r.started_at,
      lastCheckedAt: r.last_checked_at,
      isPinned: r.is_pinned,
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
        `SELECT count(*)::int AS c FROM live_status l
         JOIN channels c ON c.channel_id = l.channel_id
         WHERE l.is_live = true
           AND (c.is_pinned OR l.concurrent_viewers IS NULL OR l.concurrent_viewers < $1)
           AND (l.started_at IS NULL OR l.started_at > now() - ($2 * interval '1 hour'))`,
        [config.maxConcurrentViewers, config.maxLiveHours]
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

// チャンネルの追加/除外リクエストを受け付ける（一般ユーザー向け）。
// その場でチャンネルを解決・審査し、可能な限り保留にせず即時反映する。
app.post('/api/requests', async (req, res) => {
  try {
    const { channelUrl, channelId, type, note } = req.body || {};
    if (!['add', 'remove'].includes(type)) {
      return res.status(400).json({ error: 'type must be "add" or "remove"' });
    }
    if (!channelUrl && !channelId) {
      return res.status(400).json({ error: 'channelUrl or channelId is required' });
    }

    const resolved = await tryResolveChannel(channelId || channelUrl);

    // チャンネルを特定できなかった場合のみ、保留（要手動対応）として記録する
    if (!resolved?.channelId) {
      await query(
        `INSERT INTO requests (channel_id, channel_url, channel_title, type, note, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [channelId || null, channelUrl || null, null, type, note || null]
      );
      return res.status(202).json({
        ok: true,
        status: 'pending',
        message: 'チャンネルを自動で特定できなかったため、運営側の確認待ちになりました。',
      });
    }

    let finalStatus;
    let reason = null;

    if (type === 'add') {
      const result = classify({ channelTitle: resolved.title, channelDescription: resolved.description });
      if (result.excluded) {
        finalStatus = 'rejected';
        reason = result.reason;
      } else {
        finalStatus = 'approved';
        await applyChannelDecision(resolved.channelId, resolved.title, 'active');
      }
    } else {
      // 除外申請は内容審査の上、基本的にそのまま反映する
      finalStatus = 'approved';
      reason = 'ユーザー申請による除外';
      await applyChannelDecision(resolved.channelId, resolved.title, 'excluded', reason);
    }

    await query(
      `INSERT INTO requests (channel_id, channel_url, channel_title, type, note, status, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [resolved.channelId, channelUrl || null, resolved.title, type, note || null, finalStatus]
    );

    res.status(201).json({
      ok: true,
      status: finalStatus,
      channelTitle: resolved.title,
      message:
        type === 'add'
          ? finalStatus === 'approved'
            ? `「${resolved.title}」を追加しました。`
            : `「${resolved.title}」はVTuber/対象外と判定されたため追加できませんでした（${reason}）。誤りの場合は運営にご連絡ください。`
          : `「${resolved.title}」を除外しました。`,
    });
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

  if (action === 'approve') {
    let channelId = reqRow.channel_id;
    let channelTitle = reqRow.channel_title;

    // 申請時にチャンネルIDを解決できていなかった場合、承認時にもう一度試みる
    if (!channelId && reqRow.channel_url) {
      const resolved = await tryResolveChannel(reqRow.channel_url);
      if (resolved?.channelId) {
        channelId = resolved.channelId;
        channelTitle = resolved.title;
      }
    }

    if (!channelId) {
      return res.status(422).json({
        error: 'channel_not_resolved',
        message: 'チャンネルIDを特定できませんでした。URLを確認して申請し直してもらうか、チャンネルIDを直接調べて教えてください。',
      });
    }

    if (reqRow.type === 'add') {
      await applyChannelDecision(channelId, channelTitle, 'active');
    } else if (reqRow.type === 'remove') {
      await applyChannelDecision(channelId, channelTitle, 'excluded', '手動申請による除外');
    }

    // 解決結果をリクエストにも保存しておく（管理画面での表示用）
    await query('UPDATE requests SET channel_id = $2, channel_title = $3 WHERE id = $1', [id, channelId, channelTitle]);
  }

  await query("UPDATE requests SET status = $2, resolved_at = now() WHERE id = $1", [
    id,
    action === 'approve' ? 'approved' : 'rejected',
  ]);

  res.json({ ok: true });
});

// 管理用: 手動でバッチを1回叩く（デプロイ直後の動作確認用）
app.post('/api/admin/run/discovery', requireAdmin, async (req, res) => {
  try {
    const { runDiscovery } = await import('./discovery.js');
    const result = await runDiscovery();
    res.json(result);
  } catch (err) {
    console.error('[admin] run/discovery failed:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.post('/api/admin/run/monitor', requireAdmin, async (req, res) => {
  try {
    const { runMonitor } = await import('./monitor.js');
    const result = await runMonitor();
    res.json(result);
  } catch (err) {
    console.error('[admin] run/monitor failed:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
});
