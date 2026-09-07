import pkg from '../../../package.json';
import config from '../../../release.config.json';

export const release = {
  version: pkg.version,
  ...config,
  siteUrl: config.siteUrl ? config.siteUrl.replace(/\/?$/, '/') : '',
};
export const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
export const route = (path = '') => `${base}${path.replace(/^\//, '')}`;
export const installUrl = route('downloads/soundcloud-tempo-control.user.js');
