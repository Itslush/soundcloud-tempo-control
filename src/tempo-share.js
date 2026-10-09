export function encodeTempoCode(data) {
  return (
    'SCT1.' +
    btoa(
      Array.from(new TextEncoder().encode(JSON.stringify(data)), (byte) =>
        String.fromCharCode(byte),
      ).join(''),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
  );
}

export function tempoShareLink(data, website = '') {
  const code = encodeTempoCode(data);
  const url = website
    ? new URL('share/', website.endsWith('/') ? website : website + '/')
    : new URL('https://soundcloud.com' + data.track);
  if (website) url.hash = 'sct=' + code;
  else url.searchParams.set('sct', code);
  if (url.href.length > 8000)
    throw new Error('Too large for a link. Use Copy code instead.');
  return url.href;
}

export function decodeTempoCode(text, validate, parseTrack, website = '') {
  let code = text.trim();
  let linkedTrack = null;
  if (code.startsWith('https://')) {
    if (code.length > 8000)
      throw new Error('Link is too long. Ask for the tempo code instead.');
    const url = new URL(code);
    const landing = website
      ? new URL('share/', website.endsWith('/') ? website : website + '/')
      : null;
    if (url.username || url.password) throw new Error('Invalid share link.');
    if (url.origin === 'https://soundcloud.com') {
      linkedTrack = parseTrack(url.pathname);
      if (!linkedTrack) throw new Error('The link must point to a track.');
    } else if (
      !landing ||
      url.origin !== landing.origin ||
      url.pathname !== landing.pathname
    ) {
      throw new Error(
        'Use a SoundCloud tempo link or the Tempo Control share page.',
      );
    }
    code =
      url.searchParams.get('sct') ||
      (url.hash.startsWith('#sct=') ? url.hash.slice(5) : '');
  }
  if (code.length > 50000 || !/^SCT1\.[A-Za-z0-9_-]+$/.test(code))
    throw new Error('Paste a valid SCT1 code or tempo link.');
  const bytes = Uint8Array.from(
    atob(code.slice(5).replaceAll('-', '+').replaceAll('_', '/')),
    (character) => character.charCodeAt(0),
  );
  const data = validate(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  if (linkedTrack !== null && linkedTrack !== data.track)
    throw new Error('The link and tempo settings refer to different tracks.');
  return data;
}
