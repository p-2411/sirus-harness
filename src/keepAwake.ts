import { spawn, type ChildProcess } from 'node:child_process';
import type { Session } from './agent_runtime/session';
import { subscribeSubagents } from './agent_runtime/tools/subagents';

// Not on macOS, or caffeinate is missing: Sirus runs as it did before.
let unavailable = false;

// Keeps the Mac from idle sleep while any session of this process is working,
// a worker included, or has /rc on, so a phone can still reach it. One
// `caffeinate -i` covers them all; it is killed when nothing needs it, and by
// its own `-w` if Sirus dies first. A closed lid still sleeps the Mac.

export function keepAwake(sessions: readonly Session[]): () => void {
  let child: ChildProcess | null = null;
  const release = () => {
    child?.kill();
    child = null;
  };
  const update = () => {
    const needed = sessions.some(session => session.isRemote() || session.getStatus() === 'working'
      || session.getWorkers().some(worker => worker.status === 'working'));
    if (!needed) { release(); return; }
    if (child || unavailable) return;
    const started = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    const gone = () => { if (child === started) child = null; };
    started.on('error', () => { unavailable = true; gone(); });
    started.on('exit', gone);
    child = started;
  };
  const unsubscribes = [...sessions.map(session => session.subscribe(update)), subscribeSubagents(update)];
  update();
  return () => {
    for (const stop of unsubscribes) stop();
    release();
  };
}
