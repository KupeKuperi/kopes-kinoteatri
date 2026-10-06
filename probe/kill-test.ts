// Does stopping a session really end the moviebox-tui process? Starts an engine, then either asks
// it to quit (Ctrl+C, the normal path) or skips straight to pty.kill() (what happens when the TUI
// ignores Ctrl+C), and reports whether the process is still alive afterwards.
//   npx esbuild probe/kill-test.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/kill-test.cjs && node probe/out/kill-test.cjs [kill]
import { execFileSync } from 'node:child_process';
import { detectBinary } from '../src/main/binary';
import { classify } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';

const alive = (pid: number) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
  } catch {
    return false;
  }
};

const main = async () => {
  const bin = await detectBinary();
  if (!bin) process.exit(1);
  const session = new EngineSession(bin.path);
  session.start();
  await session.waitFor('home', (s) => classify(s) === 'home', 20000);
  const pty = (session as unknown as { pty: { pid: number; kill(): void } }).pty;
  const pid = pty.pid;
  console.log(`engine pid ${pid} running: ${alive(pid)}`);
  if (process.argv[2] === 'kill') {
    pty.kill(); // what stop() falls back to after 2 s
  } else {
    await session.stop();
  }
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`after ${process.argv[2] === 'kill' ? 'pty.kill()' : 'stop()'}: still running = ${alive(pid)}`);
  if (alive(pid)) execFileSync('taskkill', ['/PID', String(pid), '/F']);
  process.exit(0);
};

void main();
