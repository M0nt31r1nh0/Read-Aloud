// In the stable app (`npm start`), notices when a new version is deployed and
// offers it: update now (the page reloads with the open PDF and position
// kept) or keep this version, in which case the new one is used the next
// time the app is opened.

interface Release {
  version: string;
  deployedAt: string;
  notes?: string;
}

const CHECK_EVERY = 30_000;

export function watchForUpdates(current: string, update: () => Promise<void>) {
  let offered: string | null = null;
  let declined: string | null = null;

  const check = async () => {
    let release: Release;
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return;
      release = await res.json();
    } catch {
      return; // the stable server is not running right now
    }
    if (release.version === current || release.version === declined || release.version === offered) return;
    offered = release.version;
    show(release);
  };

  const show = (release: Release) => {
    document.querySelector('.update-popup')?.remove();
    const popup = document.createElement('div');
    popup.className = 'update-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-labelledby', 'update-title');
    const when = new Date(release.deployedAt);
    popup.innerHTML = `
      <strong id="update-title">A new version has been deployed</strong>
      <p class="update-meta"></p>
      <p class="update-notes" hidden></p>
      <p class="update-hint">Update now to switch (your PDF and reading position are kept), or keep this version: the new one starts the next time you open the app.</p>
      <div class="update-actions">
        <button type="button" class="primary" data-action="update">Update now</button>
        <button type="button" data-action="keep">Keep this version</button>
      </div>`;
    popup.querySelector('.update-meta')!.textContent = `Version ${release.version}, deployed ${when.toLocaleString()}`;
    if (release.notes) {
      const notes = popup.querySelector<HTMLElement>('.update-notes')!;
      notes.textContent = release.notes;
      notes.hidden = false;
    }
    popup.querySelector('[data-action="keep"]')!.addEventListener('click', () => {
      declined = release.version;
      offered = null;
      popup.remove();
    });
    const updateButton = popup.querySelector<HTMLButtonElement>('[data-action="update"]')!;
    updateButton.addEventListener('click', async () => {
      updateButton.disabled = true;
      updateButton.textContent = 'Updating…';
      try {
        await update();
      } finally {
        location.reload();
      }
    });
    document.body.append(popup);
  };

  void check();
  setInterval(check, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  window.addEventListener('focus', check);
}
