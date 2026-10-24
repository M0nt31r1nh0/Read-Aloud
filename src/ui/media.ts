// Other audio (music, a video in another tab) is paused while the app reads
// and resumed when reading pauses or stops. The local server does the pausing (see
// scripts/media.mjs); where there is none (a hosted copy) or the system is
// not supported, this does nothing.

/** False once the server says it cannot control other audio on this system. */
let available = true;
/** Whether other audio should be held paused now. */
let holding = false;
/** Something was paused for us and has not been resumed. */
let paused = false;
// One request at a time, in order: a quick Play then Stop must resume what
// the pause (still under way) paused.
let queue = Promise.resolve();

async function post(action: 'pause' | 'resume'): Promise<{ available?: boolean; paused?: boolean } | null> {
  try {
    // Without the endpoint (a hosted copy, or a stable server started before
    // this feature) nothing happens; asked again at the next start, so a
    // restarted server is used without reloading the page.
    const res = await fetch(`/media/${action}`, { method: 'POST' });
    const body = res.ok ? await res.json() : null;
    if (body?.available === false) available = false;
    return body;
  } catch {
    return null; // the server is not running right now
  }
}

/** Pause other audio (`true`, the voice reads) or resume what was paused (`false`). */
export function holdOtherAudio(hold: boolean) {
  if (hold === holding) return;
  holding = hold;
  queue = queue.then(async () => {
    if (hold) {
      if (available) paused = (await post('pause'))?.paused === true;
    } else if (paused) {
      paused = false;
      await post('resume');
    }
  });
}

// Closing or reloading the tab while reading gives the audio back too.
window.addEventListener('pagehide', () => {
  if (holding || paused) navigator.sendBeacon('/media/resume');
  holding = paused = false;
});
