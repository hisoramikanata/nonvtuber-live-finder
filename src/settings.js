import { query } from './db.js';

const MAINTENANCE_KEY = 'maintenance_mode';

export async function getMaintenanceMode() {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [MAINTENANCE_KEY]);
  return rows[0]?.value === 'true';
}

export async function setMaintenanceMode(enabled) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [MAINTENANCE_KEY, String(Boolean(enabled))]
  );
}
