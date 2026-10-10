export function initDiscordShare(code: string) {
  const root = document.querySelector<HTMLElement>('#discord-sharing');
  if (!root) return;
  const create = root.querySelector<HTMLButtonElement>('.discord-create')!;
  const copy = root.querySelector<HTMLButtonElement>('.discord-copy')!;
  const status = root.querySelector<HTMLElement>('.discord-status')!;
  const result = root.querySelector<HTMLElement>('.discord-result')!;
  const link = root.querySelector<HTMLAnchorElement>('.discord-link')!;
  const api = new URL(
    `${import.meta.env.PUBLIC_API_BASE || import.meta.env.BASE_URL}api/shares`,
    location.origin,
  );
  let job = '';
  let timer: ReturnType<typeof setTimeout>;
  let deadline = 0;
  const controller = new AbortController();
  window.addEventListener(
    'pagehide',
    () => {
      clearTimeout(timer);
      controller.abort();
    },
    { once: true },
  );

  async function request(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    });
    const value: unknown = await response.json();
    if ([404, 410].includes(response.status)) job = '';
    if (!value || typeof value !== 'object')
      throw new Error('Sharing returned an unreadable response. Try again.');
    if (!response.ok)
      throw new Error(
        'error' in value && typeof value.error === 'string'
          ? value.error
          : 'Sharing is unavailable. Try again.',
      );
    if (
      !('state' in value) ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.id)
    )
      throw new Error('Sharing returned an invalid link. Try again.');
    job = value.id;
    if (value.state === 'failed') {
      job = '';
      throw new Error(
        'error' in value && typeof value.error === 'string'
          ? value.error
          : 'Rendering failed. Try again.',
      );
    }
    if (value.state === 'ready') {
      if (!('url' in value) || typeof value.url !== 'string')
        throw new Error('The rendered link is missing. Try again.');
      const shared = new URL(value.url);
      if (
        shared.origin !== api.origin ||
        shared.pathname !== `/soundcloud-tempo-control/listen/${job}` ||
        shared.search ||
        shared.hash ||
        shared.username ||
        shared.password
      )
        throw new Error('The rendered link is invalid. Try again.');
      link.href = shared.href;
      link.textContent = shared.href;
      result.hidden = false;
      create.hidden = true;
      status.textContent =
        'Ready to share. The audio copy expires after seven days.';
      return;
    }
    if (value.state !== 'rendering')
      throw new Error('Unknown render status. Try again.');
    if (Date.now() >= deadline)
      throw new Error('Still waiting for the render. Check it again shortly.');
    status.textContent =
      'Rendering the shared track. This can take several minutes.';
    timer = setTimeout(() => request(`${api.href}/${job}`).catch(failed), 3000);
  }
  function failed(error: unknown) {
    if (controller.signal.aborted) return;
    status.textContent =
      error instanceof Error
        ? error.message
        : 'Sharing is unavailable. Try again.';
    create.disabled = false;
    create.textContent = job ? 'Check render' : 'Try again';
  }
  create.addEventListener('click', () => {
    clearTimeout(timer);
    deadline = Date.now() + 16 * 60000;
    create.disabled = true;
    status.textContent = 'Starting the render…';
    const task = job
      ? request(`${api.href}/${job}`)
      : request(api.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, publish: true }),
        });
    task.catch(failed);
  });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.href);
      status.textContent = 'Link copied.';
    } catch {
      status.textContent =
        'Copy the link above. Clipboard access is unavailable.';
    }
  });
}
