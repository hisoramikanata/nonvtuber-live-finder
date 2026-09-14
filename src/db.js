import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Railway/Renderのマネージドpostgresは自己署名証明書のことが多いので許容する
  ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
});

export async function query(text, params) {
  return pool.query(text, params);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** 今日すでに使ったクォータユニット数を取得 */
export async function getTodayQuotaUsage() {
  const { rows } = await query('SELECT used_units FROM quota_usage WHERE day = $1', [todayStr()]);
  return rows[0]?.used_units ?? 0;
}

/** クォータ使用量を加算（UPSERT） */
export async function addQuotaUsage(units) {
  await query(
    `INSERT INTO quota_usage (day, used_units) VALUES ($1, $2)
     ON CONFLICT (day) DO UPDATE SET used_units = quota_usage.used_units + EXCLUDED.used_units`,
    [todayStr(), units]
  );
}
