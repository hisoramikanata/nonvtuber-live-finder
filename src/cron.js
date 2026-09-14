// Web用サービスとは別プロセスとして動かすバッチワーカーのエントリポイント。
// Railway/Renderでは「Background Worker」や2つ目のサービスとしてこのファイルを起動する。
import cron from 'node-cron';
import { config } from './config.js';
import { runDiscovery } from './discovery.js';
import { runMonitor } from './monitor.js';

console.log('[cron] starting worker');
console.log(`[cron] discovery schedule: ${config.discoveryCron}`);
console.log(`[cron] monitor schedule:   ${config.monitorCron}`);

let discoveryRunning = false;
let monitorRunning = false;

async function safeRun(name, fn, setFlag) {
  setFlag(true);
  try {
    await fn();
  } catch (err) {
    console.error(`[cron] ${name} failed:`, err);
  } finally {
    setFlag(false);
  }
}

cron.schedule(config.discoveryCron, () => {
  if (discoveryRunning) return console.warn('[cron] discovery already running, skip this tick');
  safeRun('discovery', runDiscovery, (v) => (discoveryRunning = v));
});

cron.schedule(config.monitorCron, () => {
  if (monitorRunning) return console.warn('[cron] monitor already running, skip this tick');
  safeRun('monitor', runMonitor, (v) => (monitorRunning = v));
});

// 起動直後にも一度実行しておく
safeRun('discovery', runDiscovery, (v) => (discoveryRunning = v));
safeRun('monitor', runMonitor, (v) => (monitorRunning = v));
