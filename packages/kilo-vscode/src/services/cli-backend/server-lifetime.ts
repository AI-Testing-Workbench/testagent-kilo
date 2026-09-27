import { spawn } from "../../util/process"

const WATCH_INTERVAL_MS = 3000

/**
 * Keep a detached shared server from outliving the app.
 *
 * In shared/cloud mode the backend daemon is detached from the extension host so
 * it survives window reloads and can be shared between the editor extension and
 * the Agent Host. That also means nothing tears it down when tscode exits.
 *
 * We therefore spawn a tiny detached watcher that observes the owning tscode
 * process (`ownerPid`, the Electron main process — not the extension host, which
 * restarts on reload) and terminates the daemon once the app is gone. On a
 * window reload the app survives, so the daemon survives too; when the app
 * quits, the watcher reaps the daemon.
 */
export function spawnOwnerWatcher(nodePath: string, ownerPid: number, daemonPid: number | undefined): void {
  if (!Number.isFinite(ownerPid) || ownerPid <= 0) return

  const script = `
    const owner = Number(process.argv[1]);
    const daemon = Number(process.argv[2]) || 0;
    const alive = (pid) => {
      if (!pid) return true;
      try { process.kill(pid, 0); return true; }
      catch (e) { return !!e && e.code === 'EPERM'; }
    };
    const kill = (pid) => {
      if (!pid) return;
      try {
        if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F']);
        else process.kill(pid, 'SIGKILL');
      } catch {}
    };
    const tick = () => {
      if (!alive(owner) || (daemon && !alive(daemon))) { kill(daemon); process.exit(0); }
    };
    tick();
    setInterval(tick, ${WATCH_INTERVAL_MS});
  `

  try {
    const watcher = spawn(nodePath, ["-e", script, String(ownerPid), String(daemonPid ?? 0)], {
      detached: true,
      stdio: "ignore",
    })
    watcher.unref()
    console.log("[TestAgent] Owner watcher spawned (owner:", ownerPid, ", daemon:", daemonPid, ")")
  } catch (err) {
    console.error("[TestAgent] Failed to spawn owner watcher:", err)
  }
}
