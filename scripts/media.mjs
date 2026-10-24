// Other audio while reading: whatever is playing (music, a video in another
// tab) is paused while the app reads and resumed when reading pauses or
// stops. A web page cannot reach other apps, so the local servers (the stable
// app and the development server) do it for the page:
//
//   POST /media/pause    pause what is playing; answers {"paused": true} if
//                        something was paused
//   POST /media/resume   resume what /media/pause paused, unless the user
//                        has started something else meanwhile
//
// Each system lists its media players its own way:
//   macOS    the Now Playing app (one at a time), through MediaRemote
//   Windows  every app's media session, through Windows Runtime
//   Linux    every MPRIS player on the session bus, through dbus-send
// Where none is available the endpoints answer {"available": false} and the
// app goes on as before.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{ id: string | number, name: string, playing: boolean, paused: boolean }} Player
 * @typedef {{
 *   list(): Promise<Player[]>,
 *   pause(ids: Player['id'][]): Promise<Player['id'][]>,
 *   play(ids: Player['id'][]): Promise<Player['id'][]>,
 *   warm?(): void,
 *   close?(): void,
 * }} Players
 * A system's media players: `pause` and `play` act on the given players
 * (only those playing, or paused) and answer which ones they acted on.
 */

/**
 * Pause and resume bookkeeping over a system's `players`: everything playing
 * is paused, and only what was paused here is resumed. If the user started
 * something else meanwhile, that plays on and nothing is resumed.
 * `report(action, details)` hears what each call found (for the log).
 */
export function createMediaControl(players, report = () => {}) {
  /** @type {Player[]} */
  let held = [];
  return {
    async pause() {
      if (!players) return { available: false, paused: false };
      if (held.length) return { available: true, paused: true }; // already paused for us
      const found = await players.list();
      const playing = found.filter((p) => p.playing);
      const done = playing.length ? await players.pause(playing.map((p) => p.id)) : [];
      held = playing.filter((p) => done.includes(p.id));
      report('pause', { found, paused: held });
      return { available: true, paused: held.length > 0 };
    },
    async resume() {
      if (!players) return { available: false, resumed: false };
      if (!held.length) return { available: true, resumed: false };
      const ours = held;
      held = [];
      const found = await players.list();
      const isOurs = (p) => ours.some((o) => o.id === p.id);
      const blockedBy = found.find((p) => p.playing && !isOurs(p)) ?? null;
      const waiting = blockedBy ? [] : found.filter((p) => isOurs(p) && p.paused);
      const done = waiting.length ? await players.play(waiting.map((p) => p.id)) : [];
      const resumed = waiting.filter((p) => done.includes(p.id));
      report('resume', { found, ours, resumed, blockedBy });
      return { available: true, resumed: resumed.length > 0 };
    },
  };
}

/** Runs a program and answers its output; fails on a non-zero exit. */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') reject(Object.assign(err, { message: `${file} is not installed` }));
      else if (err) reject(Object.assign(err, { message: `${file}: ${(stderr || err.message).trim()}` }));
      else resolve(stdout);
    });
  });
}

// ---------- macOS ----------

/**
 * The Now Playing app, through a small helper built on first use (needs the
 * Xcode command line tools). macOS controls one app at a time: the one that
 * played last.
 * @returns {Players}
 */
function macPlayers() {
  const source = path.join(root, 'scripts/media/now-playing.m');
  const hash = createHash('sha1').update(fs.readFileSync(source)).update(process.arch).digest('hex').slice(0, 12);
  const library = path.join(root, 'node_modules/.cache/read-aloud', `now-playing-${hash}.dylib`);
  let built = null;
  const build = () =>
    (built ??= (async () => {
      if (fs.existsSync(library)) return;
      fs.mkdirSync(path.dirname(library), { recursive: true });
      const tmp = `${library}.${process.pid}.tmp`;
      try {
        await run('clang', ['-dynamiclib', '-fobjc-arc', '-framework', 'Foundation', '-o', tmp, source], { timeout: 60_000 });
      } catch (err) {
        built = null; // try again next time (once the tools are installed)
        throw new Error(`could not build the Now Playing helper; install the Xcode command line tools with: xcode-select --install (${err.message})`);
      }
      fs.renameSync(tmp, library);
    })());
  const PERL = [
    'require DynaLoader;',
    'my $lib = DynaLoader::dl_load_file($ARGV[0]) or die DynaLoader::dl_error();',
    'my $run = DynaLoader::dl_find_symbol($lib, "run") or die "no run";',
    'DynaLoader::dl_install_xsub("main::run", $run);',
    'run();',
  ].join(' ');
  /** @returns {Promise<{ pid: number, playing: boolean, sent: boolean }>} */
  const helper = async (env) => {
    await build();
    // Run through the system Perl: since macOS 15.4 only Apple's own
    // programs may ask what is playing.
    const out = await run('/usr/bin/perl', ['-e', PERL, library], { env: { ...process.env, ...env } });
    return JSON.parse(out);
  };
  const command = (action) => async ([pid]) => ((await helper({ MR_ACTION: action, MR_PID: String(pid) })).sent ? [pid] : []);
  return {
    async list() {
      const { pid, playing } = await helper({});
      return pid > 0 ? [{ id: pid, name: await processName(pid), playing, paused: !playing }] : [];
    },
    pause: command('pause'),
    play: command('resume'),
    warm: () => void build().catch(() => {}),
  };
}

/** "Spotify", "Opera": the program running as process `pid`. */
function processName(pid) {
  return run('ps', ['-o', 'comm=', '-p', String(pid)]).then(
    (out) => path.basename(out.trim()) || `process ${pid}`,
    () => `process ${pid}`,
  );
}

// ---------- Windows ----------

/** Friendly names for the ids Windows gives some apps' media sessions. */
const WINDOWS_APPS = {
  MSEdge: 'Microsoft Edge',
  Chrome: 'Google Chrome',
  '308046B0AF4A39CB': 'Firefox',
  'Microsoft.ZuneMusic': 'Media Player',
  'SpotifyAB.SpotifyMusic': 'Spotify',
};

/** "Spotify.exe" → "Spotify", "MSEdge" → "Microsoft Edge", Store apps by package name. */
export function windowsAppName(id) {
  const base = String(id).split('!')[0].split('\\').pop().replace(/\.exe$/i, '').replace(/_[a-z0-9]{13}$/, '');
  return WINDOWS_APPS[base] ?? base;
}

/**
 * Every app's media session, through a PowerShell worker kept running
 * (starting PowerShell takes a moment; answering a request does not).
 * @returns {Players}
 */
function windowsPlayers() {
  let worker = null;
  const ask = (request) => {
    worker ??= startWorker();
    return worker.ask(JSON.stringify(request)).then((line) => {
      const answer = JSON.parse(line);
      if (answer.error) throw new Error(`Windows media sessions: ${answer.error}`);
      return answer;
    });
  };
  const startWorker = () => {
    const script = fs.readFileSync(path.join(root, 'scripts/media/windows-sessions.ps1'), 'utf8');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true },
    );
    const self = lineWorker(child, () => {
      if (worker === self) worker = null; // started again on the next request
    });
    return self;
  };
  return {
    async list() {
      const { players } = await ask({ action: 'list' });
      return players.map(({ id, status }) => ({ id, name: windowsAppName(id), playing: status === 'Playing', paused: status === 'Paused' }));
    },
    pause: async (ids) => (await ask({ action: 'pause', ids })).done,
    play: async (ids) => (await ask({ action: 'play', ids })).done,
    warm: () => void ask({ action: 'list' }).catch(() => {}),
    close: () => worker?.close(),
  };
}

/**
 * A child process answering one line per request line, in order. A request
 * that gets no answer in time ends the process (the next request starts a
 * new one through `onExit`).
 */
function lineWorker(child, onExit) {
  const waiting = [];
  let buffer = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; ) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) waiting.shift()?.resolve(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-2000)));
  const fail = (err) => {
    for (const w of waiting.splice(0)) w.reject(err);
  };
  child.on('error', (err) => fail(err));
  child.on('exit', (code) => {
    onExit();
    fail(new Error(`media worker stopped (${code}): ${errors.trim() || 'no message'}`));
  });
  // Never keeps the server (or a test run) from exiting.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
  return {
    ask(line) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('media worker did not answer'));
          child.kill();
        }, 10_000);
        timer.unref();
        waiting.push({
          resolve: (answer) => (clearTimeout(timer), resolve(answer)),
          reject: (err) => (clearTimeout(timer), reject(err)),
        });
        child.stdin.write(`${line}\n`);
      });
    },
    close: () => child.kill(),
  };
}

// ---------- Linux ----------

/**
 * Every MPRIS player on the session bus (Spotify, browsers, VLC, Rhythmbox…),
 * through dbus-send (package "dbus", on nearly every desktop). `exec(file,
 * args)` runs a program (replaced in tests).
 * @returns {Players}
 */
export function linuxPlayers(exec = run) {
  const OBJECT = '/org/mpris/MediaPlayer2';
  const send = (destination, ...args) => exec('dbus-send', ['--session', '--print-reply', `--dest=${destination}`, ...args]);
  const property = async (id, iface, name) => {
    const out = await send(id, OBJECT, 'org.freedesktop.DBus.Properties.Get', `string:${iface}`, `string:${name}`);
    return /variant\s+string "((?:[^"\\]|\\.)*)"/.exec(out)?.[1] ?? '';
  };
  const command = (method) => async (ids) => {
    const done = [];
    for (const id of ids) {
      try {
        await send(id, OBJECT, `org.mpris.MediaPlayer2.Player.${method}`);
        done.push(id);
      } catch {
        // Closed in the meantime.
      }
    }
    return done;
  };
  return {
    async list() {
      const out = await send('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames');
      const ids = [...out.matchAll(/string "(org\.mpris\.MediaPlayer2\.[^"]+)"/g)].map((m) => m[1]);
      return Promise.all(
        ids.map(async (id) => {
          const status = await property(id, 'org.mpris.MediaPlayer2.Player', 'PlaybackStatus').catch(() => '');
          const identity = await property(id, 'org.mpris.MediaPlayer2', 'Identity').catch(() => '');
          const name = identity || id.replace('org.mpris.MediaPlayer2.', '').replace(/\.instance.*$/, '');
          return { id, name, playing: status === 'Playing', paused: status === 'Paused' };
        }),
      );
    },
    pause: command('Pause'),
    play: command('Play'),
  };
}

/** The media players of the system this runs on, or null if it has no supported way. */
export function systemPlayers(platform = process.platform) {
  if (platform === 'darwin') return macPlayers();
  if (platform === 'win32') return windowsPlayers();
  if (platform === 'linux') return linuxPlayers();
  return null;
}

// ---------- requests ----------

const names = (players) => players.map((p) => p.name).join(', ');

/** One line in the server's terminal for each pause and resume. */
function logMedia(action, { found, paused, ours, resumed, blockedBy }) {
  let message;
  if (action === 'pause') {
    const playing = found.filter((p) => p.playing);
    message = paused.length ? `paused ${names(paused)}` : playing.length ? `could not pause ${names(playing)}` : 'found nothing playing';
  } else if (resumed.length) {
    message = `resumed ${names(resumed)}`;
  } else if (blockedBy) {
    message = `left ${names(ours)} paused: ${blockedBy.name} is playing now`;
  } else {
    const still = found.filter((p) => ours.some((o) => o.id === p.id));
    message = `did not resume ${names(ours)}: ${!still.length ? 'no longer open' : still.some((p) => p.playing) ? 'already playing' : 'no answer'}`;
  }
  console.log(`${new Date().toLocaleTimeString()}  Other audio: ${message}`);
}

const players = systemPlayers();
const control = createMediaControl(players, logMedia);
let warmed = false;

/**
 * Handles /media/pause and /media/resume; returns false for other requests.
 * Only pages of this app may call it: another site could otherwise pause
 * your music.
 */
export function handleMediaRequest(req, res) {
  // The first page load gets the helper ready, so the first Play is quick.
  if (!warmed) {
    warmed = true;
    players?.warm?.();
  }
  const action = /^\/media\/(pause|resume)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)?.[1];
  if (!action) return false;
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'POST only' }), true;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(req.headers.origin).host === req.headers.host;
  } catch {
    // No or malformed Origin: not one of our pages.
  }
  if (!sameOrigin) return reply(403, { error: 'Forbidden' }), true;
  req.resume(); // the body is not used
  control[action]().then(
    (result) => reply(200, result),
    (err) => {
      // Reported, and tried again next time (a missing tool can be installed).
      console.warn(`Other audio: ${action} failed: ${err.message}`);
      reply(200, { available: true, error: err.message });
    },
  );
  return true;
}
