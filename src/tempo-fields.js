export function enhanceTempoFields(root) {
  const syncs = [];
  for (const input of root.querySelectorAll(
    'input[type="number"]:not(#rate-number)',
  )) {
    const wrap = document.createElement('span');
    wrap.className = 'tempo-number';
    input.before(wrap);
    wrap.append(input);
    const arrows = document.createElement('span');
    arrows.className = 'tempo-number-arrows';
    wrap.append(arrows);
    const label =
      input.getAttribute('aria-label') ||
      [...(input.labels?.[0]?.childNodes || [])]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent.trim())
        .join(' ') ||
      'value';
    function nudge(direction) {
      if (input.disabled || input.readOnly) return;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value)) return;
      const min = input.min === '' ? -Infinity : Number(input.min);
      const max = input.max === '' ? Infinity : Number(input.max);
      input.value = String(
        Math.max(
          min,
          Math.min(
            max,
            Math.round((value + direction * (Number(input.step) || 1)) * 1e6) /
              1e6,
          ),
        ),
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }
    const buttons = [1, -1].map((direction) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute(
        'aria-label',
        (direction > 0 ? 'Increase ' : 'Decrease ') + label,
      );
      button.innerHTML =
        '<svg viewBox="0 0 10 8" aria-hidden="true"><path d="' +
        (direction > 0 ? 'm2 5 3-3 3 3' : 'm2 3 3 3 3-3') +
        '"/></svg>';
      button.onclick = () => nudge(direction);
      arrows.append(button);
      return button;
    });
    function sync() {
      buttons.forEach((button, index) => {
        button.disabled =
          input.disabled ||
          input.readOnly ||
          (index
            ? input.min !== '' && input.valueAsNumber <= Number(input.min)
            : input.max !== '' && input.valueAsNumber >= Number(input.max));
      });
    }
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      nudge(event.key === 'ArrowUp' ? 1 : -1);
    });
    input.addEventListener('change', sync);
    syncs.push(sync);
  }
  for (const select of root.querySelectorAll('select')) {
    const wrap = document.createElement('span');
    wrap.className = 'tempo-choice';
    select.before(wrap);
    wrap.append(select);
    select.hidden = true;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'tempo-choice-trigger';
    const caption = document.createElement('span');
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('viewBox', '0 0 10 8');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<path d="m2 3 3 3 3-3"/>';
    trigger.append(caption, chevron);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const name =
      select.getAttribute('aria-label') ||
      [...(select.labels?.[0]?.childNodes || [])]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent.trim())
        .join(' ') ||
      'Choose';
    const list = document.createElement('span');
    list.className = 'tempo-choice-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', name);
    list.hidden = true;
    wrap.append(trigger, list);
    function close(focus = false) {
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    function sync() {
      caption.textContent = select.selectedOptions[0]?.textContent || 'Choose';
      trigger.setAttribute(
        'aria-label',
        name + ': ' + (select.selectedOptions[0]?.textContent || ''),
      );
      trigger.disabled = select.disabled;
    }
    function open() {
      list.replaceChildren(
        ...[...select.options].map((option) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', String(option.selected));
          button.tabIndex = -1;
          button.disabled = option.disabled;
          button.textContent = option.textContent;
          button.onclick = () => {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            sync();
            close(true);
          };
          return button;
        }),
      );
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      (list.children[select.selectedIndex] || list.firstElementChild)?.focus();
    }
    trigger.onclick = () => (list.hidden ? open() : close());
    let search = '',
      searchTime = 0;
    wrap.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') {
        close();
        return;
      }
      const options = [...list.children].filter((option) => !option.disabled);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (list.hidden) {
          open();
          return;
        }
        const active = wrap.getRootNode().activeElement;
        const index = options.indexOf(active);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : (index +
                  (event.key === 'ArrowDown' ? 1 : -1) +
                  options.length) %
                options.length;
        options[next]?.focus();
      } else if (
        event.key.length === 1 &&
        event.key !== ' ' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const now = Date.now();
        search =
          (now - searchTime < 700 ? search : '') + event.key.toLowerCase();
        searchTime = now;
        if (list.hidden) open();
        [...list.children]
          .find((option) =>
            option.textContent.trim().toLowerCase().startsWith(search),
          )
          ?.focus();
      }
    });
    wrap.addEventListener('focusout', (event) => {
      if (!wrap.contains(event.relatedTarget)) close();
    });
    root.addEventListener('pointerdown', (event) => {
      if (!wrap.contains(event.target)) close();
    });
    select.addEventListener('change', sync);
    syncs.push(sync);
  }
  const sync = () => syncs.forEach((update) => update());
  sync();
  return sync;
}

export const tempoFieldStyle = `
.tempo-number { display:inline-flex; align-items:center; min-width:0; vertical-align:middle; }
.tempo-number input { appearance:textfield; min-width:0; width:64px; }
.tempo-number input::-webkit-inner-spin-button,.tempo-number input::-webkit-outer-spin-button { appearance:none; margin:0; }
.tempo-number-arrows { display:grid; flex-shrink:0; }
.tempo-number-arrows button { display:grid; place-items:center; min-height:16px; width:22px; padding:0; border:0; background:transparent; color:inherit; }
.tempo-number-arrows svg { width:10px; height:8px; fill:none; stroke:currentColor; stroke-width:1.4; }
.tempo-choice { position:relative; display:inline-block; min-width:0; }
.tempo-choice-trigger { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; text-align:left; color:inherit; }
.tempo-choice-trigger > svg { flex:none; width:10px; height:8px; fill:none; stroke:currentColor; stroke-width:1.5; }
.tempo-choice-trigger[aria-expanded="true"] > svg { transform:rotate(180deg); }
.tempo-choice-list { position:absolute; z-index:5; left:0; top:100%; min-width:100%; max-width:240px; max-height:220px; overflow:auto; padding:4px; border:1px solid var(--tempo-track); background:var(--tempo-surface); box-shadow:0 4px 12px #0004; }
.tempo-choice-list button { display:block; width:100%; text-align:left; border:0; color:inherit; min-height:32px; }
.tempo-choice-list [aria-selected="true"] { color:var(--tempo-fg); box-shadow:inset 2px 0 var(--tempo-accent); }
.tempo-number-arrows button:focus-visible,.tempo-choice button:focus-visible { outline:2px solid var(--tempo-accent); outline-offset:1px; }
.tempo-number-arrows button:disabled { opacity:.35; }
`;
