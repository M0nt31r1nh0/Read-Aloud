// In the stable app (`npm start`), notices when a new version is deployed and
// offers it: update now (the page reloads with the open PDF and position
// kept) or keep this version, in which case the new one is used the next
// time the app is opened. Each check offers the newest version; a popup
// still on screen is replaced, never stacked.
//
// Old versions are kept for a while, then removed. A tab still running a
// removed version can no longer load its files (opening another PDF fails),
// so it is told, and offered only the update.

interface Release {
  version: string;
  deployedAt: string;
  notes?: string;
  /** Releases the stable server still has (older servers do not say). */
  available?: string[];
}

export interface UpdateWatch {
  /** Check now (for example after something failed to load). */
  check(): Promise<void>;
}

const CHECK_EVERY = 30_000;

/**
 * `onReachable` reports whether the stable server answers: when it is not
 * running, no update can be noticed, and the app says so.
 */
export function watchForUpdates(current: string, update: () => Promise<void>, onReachable: (reachable: boolean) => void): UpdateWatch {
  let offered: string | null = null;
  let declined: string | null = null;
  let goneShown = false;

  const check = async () => {
    let release: Release;
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      release = await res.json();
    } catch {
      onReachable(false); // the stable server is not running right now
      return;
    }
    onReachable(true);
    if (release.version === current) return;
    const gone = !!release.available && !release.available.includes(current);
    if (gone) {
      // "Keep this version" is no longer possible: offered even if declined.
      if (goneShown && offered === release.version) return;
      goneShown = true;
    } else if (release.version === declined || release.version === offered) return;
    offered = release.version;
    show(release, gone);
  };

  const show = (release: Release, gone: boolean) => {
    document.querySelector('.update-popup')?.remove();
    const popup = document.createElement('div');
    popup.className = 'update-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-labelledby', 'update-title');
    const when = new Date(release.deployedAt);
    popup.innerHTML = `
      <strong id="update-title"></strong>
      <p class="update-meta"></p>
      <p class="update-notes" hidden></p>
      <p class="update-hint"></p>
      <div class="update-actions">
        <button type="button" class="primary" data-action="update">Update now</button>
        <button type="button" data-action="keep">Keep this version</button>
      </div>`;
    popup.querySelector('#update-title')!.textContent = gone ? 'This version is no longer available' : 'A new version has been deployed';
    popup.querySelector('.update-meta')!.textContent = `${gone ? 'Newest: version' : 'Version'} ${release.version}, deployed ${when.toLocaleString()}`;
    popup.querySelector('.update-hint')!.textContent = gone
      ? 'The version open here was removed from the stable app, so opening another PDF would fail. Update to keep reading: your PDF and reading position are kept.'
      : 'Update now to switch (your PDF and reading position are kept), or keep this version: the new one starts the next time you open the app.';
    if (release.notes) {
      const notes = popup.querySelector<HTMLElement>('.update-notes')!;
      notes.textContent = release.notes;
      notes.hidden = false;
    }
    const keepButton = popup.querySelector<HTMLButtonElement>('[data-action="keep"]')!;
    if (gone) keepButton.remove();
    else {
      keepButton.addEventListener('click', () => {
        declined = release.version;
        offered = null;
        popup.remove();
      });
    }
    const updateButton = popup.querySelector<HTMLButtonElement>('[data-action="update"]')!;
    updateButton.addEventListener('click', async () => {
      updateButton.disabled = true;
      updateButton.textContent = 'Updating…';
      try {
        await update();
      } finally {
        // The app's address always serves the newest version.
        location.assign('/');
      }
    });
    document.body.append(popup);
  };

  void check();
  setInterval(check, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  window.addEventListener('focus', check);
  return { check };
}
