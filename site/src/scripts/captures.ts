const dialog = document.querySelector<HTMLDialogElement>('.capture-viewer');

document
  .querySelectorAll<HTMLImageElement>('.capture-surface img')
  .forEach((image) => {
    const picture = image.closest('picture')!;
    function finish() {
      delete picture.dataset.loading;
      picture.toggleAttribute('data-error', image.naturalWidth === 0);
      picture.setAttribute('aria-busy', 'false');
    }
    if (image.complete) {
      finish();
      return;
    }
    picture.dataset.loading = '';
    picture.setAttribute('aria-busy', 'true');
    image.addEventListener('load', finish);
    image.addEventListener('error', finish);
  });

if (dialog) {
  const image = dialog.querySelector<HTMLImageElement>('.viewer-image')!;
  const stage = dialog.querySelector<HTMLElement>('.viewer-stage')!;
  const title = dialog.querySelector<HTMLElement>('#capture-title')!;
  const loading = dialog.querySelector<HTMLElement>('.viewer-loading')!;
  const error = dialog.querySelector<HTMLElement>('.viewer-error')!;
  const original = dialog.querySelector<HTMLAnchorElement>('.viewer-original')!;
  const zoomLabel = dialog.querySelector<HTMLOutputElement>('.viewer-zoom')!;
  const zoomIn = dialog.querySelector<HTMLButtonElement>('.viewer-in')!;
  const zoomOut = dialog.querySelector<HTMLButtonElement>('.viewer-out')!;
  const sizeButtons = dialog.querySelectorAll<HTMLButtonElement>(
    '.viewer-fit, .viewer-actual',
  );
  let opener: HTMLAnchorElement | null = null;
  let nativeWidth = 720;
  let nativeHeight = 720;
  let zoom = 1;
  let fit = false;
  let scrollStyle = '';
  let request = 0;
  let focusX = 0;
  let focusY = 0;

  function setZoom(value: number, fitted = false) {
    const previous = zoom;
    const centerX = stage.scrollLeft + stage.clientWidth / 2;
    const centerY = stage.scrollTop + stage.clientHeight / 2;
    zoom = Math.max(fitted ? 0.05 : 0.25, Math.min(3, value));
    fit = fitted;
    image.style.width = `${nativeWidth * zoom}px`;
    zoomLabel.value = `${Math.round(zoom * 100)}%`;
    zoomOut.disabled = zoom <= 0.25;
    zoomIn.disabled = zoom >= 3;
    stage.scrollLeft = (centerX * zoom) / previous - stage.clientWidth / 2;
    stage.scrollTop = (centerY * zoom) / previous - stage.clientHeight / 2;
  }

  function fitImage() {
    setZoom(
      Math.min(
        (stage.clientWidth - 24) / nativeWidth,
        (stage.clientHeight - 24) / nativeHeight,
        1,
      ),
      true,
    );
    stage.scrollTo(0, 0);
  }

  async function loadImage() {
    const current = ++request;
    loading.hidden = false;
    error.hidden = true;
    image.hidden = true;
    zoomIn.disabled = true;
    zoomOut.disabled = true;
    sizeButtons.forEach((button) => (button.disabled = true));
    stage.setAttribute('aria-busy', 'true');
    image.src = original.href;
    try {
      await image.decode();
      if (current !== request || !dialog?.open) return;
      image.hidden = false;
      loading.hidden = true;
      stage.setAttribute('aria-busy', 'false');
      sizeButtons.forEach((button) => (button.disabled = false));
      setZoom(1);
      stage.scrollTo(
        Math.max(0, focusX - stage.clientWidth / 2),
        Math.max(0, focusY - stage.clientHeight / 2),
      );
    } catch {
      if (current !== request) return;
      loading.hidden = true;
      error.hidden = false;
      stage.setAttribute('aria-busy', 'false');
    }
  }

  document
    .querySelectorAll<HTMLAnchorElement>('a[data-capture]')
    .forEach((link) => {
      link.addEventListener('click', (event) => {
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        if (typeof dialog.showModal !== 'function') return;
        event.preventDefault();
        opener = link;
        nativeWidth = Number(link.dataset.nativeWidth) || 720;
        nativeHeight = Number(link.dataset.nativeHeight) || 720;
        focusX = Number(link.dataset.focusX) || 0;
        focusY = Number(link.dataset.focusY) || 0;
        title.textContent = link.dataset.title || 'Full interface';
        original.href = link.href;
        image.alt = link.querySelector('img')?.alt || title.textContent || '';
        scrollStyle = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        dialog.showModal();
        zoom = 1;
        fit = false;
        void loadImage();
      });
    });

  dialog
    .querySelector('.viewer-close')!
    .addEventListener('click', () => dialog.close());
  dialog.querySelector('.viewer-fit')!.addEventListener('click', fitImage);
  dialog
    .querySelector('.viewer-actual')!
    .addEventListener('click', () => setZoom(1));
  dialog
    .querySelector('.viewer-retry')!
    .addEventListener('click', () => void loadImage());
  zoomIn.addEventListener('click', () => setZoom(zoom + 0.25));
  zoomOut.addEventListener('click', () => setZoom(zoom - 0.25));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  dialog.addEventListener('close', () => {
    request++;
    document.documentElement.style.overflow = scrollStyle;
    opener?.focus({ preventScroll: true });
  });
  window.addEventListener('resize', () => {
    if (dialog.open && fit) fitImage();
  });
}
