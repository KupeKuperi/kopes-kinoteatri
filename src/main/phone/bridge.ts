// While phone access is on, the engine's VLC and mpv are small stand-ins written here. The engine
// starts one exactly as it would start the player; the stand-in asks the app what to do with it:
// start the real player with the same arguments (the engine waits on it as always, so watch
// progress and its stream relay behave as before), or hand the stream to the phone that asked for
// it and stay running until the phone is done. If the app doesn't answer, the real player starts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseLaunch, type PlayerLaunch } from './launch';

/** Started by Electron in Node mode: `<app> <this file> <player> <the player's arguments…>`. */
const STAND_IN = `'use strict';
// Written by Kope's Kinoteatri (phone access): moviebox-tui starts this instead of its video player.
const http = require('http');
const { spawn } = require('child_process');
const [player, ...args] = process.argv.slice(2);
const real = process.env['KK_REAL_' + String(player).toUpperCase()];
function runReal() {
  if (!real) {
    process.stderr.write('No ' + player + ' player is installed on this computer.\\n');
    process.exit(1);
  }
  // A .cmd or .bat player runs through cmd.exe, quoted the way cmd reads it.
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(real);
  const quote = (a) => '"' + String(a).replace(/"/g, '""').replace(/%/g, '%%cd:~,%') + '"';
  const child = batch
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/e:ON', '/v:OFF', '/c', '"' + [real, ...args].map(quote).join(' ') + '"'], { stdio: 'inherit', windowsVerbatimArguments: true })
    : spawn(real, args, { stdio: 'inherit' });
  child.on('error', (e) => { process.stderr.write(String(e) + '\\n'); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
}
const req = http.request(
  { host: '127.0.0.1', port: Number(process.env.KK_PLAYER_PORT), path: '/launch', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kk-key': process.env.KK_PLAYER_KEY || '' } },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      let answer = {};
      try { answer = JSON.parse(body); } catch {}
      if (answer.action === 'phone') process.exit(0);
      else runReal();
    });
    res.on('error', runReal);
  },
);
req.on('error', runReal);
req.end(JSON.stringify({ player, args }));
`;

export type LaunchDecision = { phone: true; done: Promise<void> } | null;

export class PlayerBridge {
  private server: http.Server | null = null;
  private port = 0;
  private readonly key = crypto.randomBytes(18).toString('base64url');

  /**
   * Decides each launch: null starts the real player; otherwise the phone has it, and the
   * stand-in keeps running until `done` settles.
   */
  onLaunch: (launch: PlayerLaunch) => LaunchDecision = () => null;

  constructor(private readonly dir: string) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const answer = (action: 'player' | 'phone') => {
      if (!res.writableEnded) res.end(JSON.stringify({ action }));
    };
    if (req.method !== 'POST' || req.url !== '/launch' || req.headers['x-kk-key'] !== this.key) {
      res.statusCode = 404;
      return res.end();
    }
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    let launch: PlayerLaunch | null = null;
    try {
      const { player, args } = JSON.parse(body) as { player: string; args: string[] };
      launch = parseLaunch(player, args);
    } catch {
      /* not ours to judge: just play */
    }
    const decision = launch ? this.onLaunch(launch) : null;
    if (!decision) return answer('player');
    res.setHeader('content-type', 'application/json');
    decision.done.then(
      () => answer('phone'),
      () => answer('phone'),
    );
  }

  /**
   * Environment for the engine: its VLC and mpv become the stand-ins (only players that are
   * installed, so the engine's own choice of player doesn't change). An empty path is a stand-in
   * with no real player behind it: phones can watch, the computer can't.
   */
  engineEnv(players: { vlc: string | null; mpv: string | null }): Record<string, string> {
    if (!this.server) return {};
    fs.mkdirSync(this.dir, { recursive: true });
    const script = path.join(this.dir, 'player-stand-in.cjs');
    fs.writeFileSync(script, STAND_IN);
    const env: Record<string, string> = {
      KK_PLAYER_PORT: String(this.port),
      KK_PLAYER_KEY: this.key,
      // Paths travel in the environment: a .cmd file is read in the console's code page, which
      // can't spell every folder name (a Georgian user name, say).
      KK_PLAYER_NODE: process.execPath,
      KK_PLAYER_SCRIPT: script,
    };
    for (const [player, real] of Object.entries(players)) {
      if (real === null) continue;
      if (real) env[`KK_REAL_${player.toUpperCase()}`] = real;
      env[`MOVIEBOX_${player.toUpperCase()}_PATH`] = this.writeLauncher(player);
    }
    return env;
  }

  /** The file the engine starts as `player`: it runs the stand-in with Electron in Node mode. */
  private writeLauncher(player: string): string {
    if (process.platform === 'win32') {
      // The engine (Rust) runs .cmd files through cmd.exe, quoting the arguments for it.
      const file = path.join(this.dir, `${player}-stand-in.cmd`);
      fs.writeFileSync(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%KK_PLAYER_NODE%" "%KK_PLAYER_SCRIPT%" ${player} %*\r\nexit /b %errorlevel%\r\n`);
      return file;
    }
    const file = path.join(this.dir, `${player}-stand-in.sh`);
    fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$KK_PLAYER_NODE" "$KK_PLAYER_SCRIPT" ${player} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    return file;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
