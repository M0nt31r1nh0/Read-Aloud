import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS server module
import { createMediaControl, handleMediaRequest, linuxPlayers, systemPlayers, windowsAppName } from '../scripts/media.mjs';

type Status = 'Playing' | 'Paused' | 'Stopped';

/** Fake media players, by id, with the calls made to them. */
function fakeSystem(players: Record<string, Status>) {
  const calls: string[] = [];
  const system = {
    players,
    calls,
    async list() {
      return Object.entries(system.players).map(([id, status]) => ({ id, name: id, playing: status === 'Playing', paused: status === 'Paused' }));
    },
    async pause(ids: string[]) {
      calls.push(`pause ${ids}`);
      return ids.filter((id) => system.players[id] === 'Playing' && (system.players[id] = 'Paused'));
    },
    async play(ids: string[]) {
      calls.push(`play ${ids}`);
      return ids.filter((id) => system.players[id] === 'Paused' && (system.players[id] = 'Playing'));
    },
  };
  return system;
}

describe('pausing other audio while reading', () => {
  it('pauses what is playing and resumes it afterwards', async () => {
    const system = fakeSystem({ Spotify: 'Playing' });
    const control = createMediaControl(system);
    expect(await control.pause()).toEqual({ available: true, paused: true });
    expect(system.players.Spotify).toBe('Paused');
    expect(await control.resume()).toEqual({ available: true, resumed: true });
    expect(system.players.Spotify).toBe('Playing');
  });

  it('pauses every player that plays, and resumes only those', async () => {
    const system = fakeSystem({ Spotify: 'Playing', Firefox: 'Playing', VLC: 'Paused' });
    const control = createMediaControl(system);
    await control.pause();
    await control.resume();
    expect(system.players).toEqual({ Spotify: 'Playing', Firefox: 'Playing', VLC: 'Paused' });
    expect(system.calls).toEqual(['pause Spotify,Firefox', 'play Spotify,Firefox']);
  });

  it('does not start audio that was not playing', async () => {
    const system = fakeSystem({ Spotify: 'Paused' });
    const control = createMediaControl(system);
    expect((await control.pause()).paused).toBe(false);
    expect((await control.resume()).resumed).toBe(false);
    expect(system.calls).toEqual([]);
  });

  it('leaves its players paused when the user started something else', async () => {
    const system = fakeSystem({ Spotify: 'Playing', YouTube: 'Paused' });
    const control = createMediaControl(system);
    await control.pause();
    system.players.YouTube = 'Playing';
    expect((await control.resume()).resumed).toBe(false);
    expect(system.players.Spotify).toBe('Paused');
  });

  it('does not play again what the user already resumed or closed', async () => {
    const system = fakeSystem({ Spotify: 'Playing', Music: 'Playing' });
    const control = createMediaControl(system);
    await control.pause();
    system.players.Spotify = 'Playing';
    delete system.players.Music;
    // Spotify playing again is the user's doing: it is one of ours, so not "something else".
    expect((await control.resume()).resumed).toBe(false);
    expect(system.calls).toEqual(['pause Spotify,Music']);
  });

  it('pauses once while held, and resumes once', async () => {
    const system = fakeSystem({ Spotify: 'Playing' });
    const control = createMediaControl(system);
    await control.pause();
    await control.pause();
    await control.resume();
    await control.resume();
    expect(system.calls).toEqual(['pause Spotify', 'play Spotify']);
  });

  it('reports what it found, for the server log', async () => {
    const system = fakeSystem({ Spotify: 'Playing' });
    const reports: [string, Record<string, unknown>][] = [];
    const control = createMediaControl(system, (action: string, details: Record<string, unknown>) => reports.push([action, details]));
    await control.pause();
    system.players.Radio = 'Playing';
    await control.resume();
    const ids = (players: unknown) => (players as { id: string }[] | undefined)?.map((p) => p.id);
    expect(reports.map(([action, d]) => [action, ids(d.paused), (d.blockedBy as { id: string } | null)?.id])).toEqual([
      ['pause', ['Spotify'], undefined],
      ['resume', undefined, 'Radio'],
    ]);
  });

  it('reports when the system is not supported', async () => {
    const control = createMediaControl(null);
    expect(await control.pause()).toEqual({ available: false, paused: false });
  });
});

describe('Linux media players (MPRIS)', () => {
  const reply = (body: string) => `method return time=1.0 sender=:1.5 -> destination=:1.9 serial=4 reply_serial=2\n${body}\n`;
  const bus: Record<string, { status: string; identity?: string }> = {
    'org.mpris.MediaPlayer2.spotify': { status: 'Playing', identity: 'Spotify' },
    'org.mpris.MediaPlayer2.firefox.instance_1_42': { status: 'Paused' },
  };
  const calls: string[] = [];
  // dbus-send as it answers: its arguments are [--session, --print-reply, --dest=…, object, method, …args].
  const exec = async (file: string, args: string[]) => {
    expect(file).toBe('dbus-send');
    const dest = args[2].slice('--dest='.length);
    const method = args[4];
    if (method === 'org.freedesktop.DBus.ListNames') {
      const busNames = ['org.freedesktop.DBus', ':1.0', ...Object.keys(bus)];
      return reply(`   array [\n${busNames.map((n) => `      string "${n}"`).join('\n')}\n   ]`);
    }
    if (method.startsWith('org.mpris.MediaPlayer2.Player.')) {
      calls.push(`${method.split('.').pop()} ${dest}`);
      return reply('');
    }
    expect(method).toBe('org.freedesktop.DBus.Properties.Get');
    const value = args[6] === 'string:PlaybackStatus' ? bus[dest].status : bus[dest].identity;
    if (value === undefined) throw new Error('No such property');
    return reply(`   variant       string "${value}"`);
  };

  it('lists the players on the session bus', async () => {
    expect(await linuxPlayers(exec).list()).toEqual([
      { id: 'org.mpris.MediaPlayer2.spotify', name: 'Spotify', playing: true, paused: false },
      { id: 'org.mpris.MediaPlayer2.firefox.instance_1_42', name: 'firefox', playing: false, paused: true },
    ]);
  });

  it('pauses and plays players by bus name', async () => {
    const players = linuxPlayers(exec);
    expect(await players.pause(['org.mpris.MediaPlayer2.spotify'])).toEqual(['org.mpris.MediaPlayer2.spotify']);
    expect(await players.play(['org.mpris.MediaPlayer2.spotify'])).toEqual(['org.mpris.MediaPlayer2.spotify']);
    expect(calls).toEqual(['Pause org.mpris.MediaPlayer2.spotify', 'Play org.mpris.MediaPlayer2.spotify']);
  });
});

describe('Windows media sessions', () => {
  it('names apps by their session ids', () => {
    expect(windowsAppName('Spotify.exe')).toBe('Spotify');
    expect(windowsAppName('MSEdge')).toBe('Microsoft Edge');
    expect(windowsAppName('308046B0AF4A39CB')).toBe('Firefox');
    expect(windowsAppName('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic')).toBe('Media Player');
    expect(windowsAppName('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe')).toBe('vlc');
  });
});

// The real helper of the system running the tests, read only: it lists the
// players and changes nothing. On Linux only with a session bus.
const { platform, env } = (globalThis as unknown as { process: { platform: string; env: Record<string, string | undefined> } }).process;
const canList = platform === 'darwin' || platform === 'win32' || (platform === 'linux' && !!env.DBUS_SESSION_BUS_ADDRESS);
describe.runIf(canList)('this system’s media players', () => {
  const players = systemPlayers();
  afterAll(() => players?.close?.());

  it('can be listed', { timeout: 60_000 }, async () => {
    const found = await players.list();
    expect(Array.isArray(found)).toBe(true);
    for (const p of found) expect(typeof p.name).toBe('string');
  });
});

describe('media requests', () => {
  const request = (method: string, url: string, origin?: string) => {
    const response = { status: 0, body: '' };
    const res = {
      writeHead: (status: number) => void (response.status = status),
      end: (body: string) => void (response.body = body),
    };
    const req = { method, url, headers: { host: 'localhost:4173', ...(origin ? { origin } : {}) }, resume() {} };
    return { handled: handleMediaRequest(req, res), response };
  };

  it('ignores other paths', () => {
    expect(request('GET', '/version.json').handled).toBe(false);
  });

  it('only takes POST', () => {
    expect(request('GET', '/media/pause', 'http://localhost:4173').response.status).toBe(405);
  });

  it('refuses other sites, so they cannot pause your music', () => {
    expect(request('POST', '/media/pause', 'https://example.com').response.status).toBe(403);
    expect(request('POST', '/media/pause').response.status).toBe(403);
  });
});
