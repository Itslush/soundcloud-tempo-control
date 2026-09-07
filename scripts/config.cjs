const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function httpsUrl(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be a public HTTPS URL without credentials`);
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} cannot point to localhost`);
  }
  return url.href;
}

function validateConfig(input, release = false) {
  const siteUrl = httpsUrl(input.siteUrl, 'siteUrl');
  const paypalUrl = httpsUrl(input.paypalUrl, 'paypalUrl');
  const repositoryUrl = httpsUrl(input.repositoryUrl, 'repositoryUrl');
  if (release && !siteUrl)
    throw new Error(
      'Set siteUrl in release.config.json before a public release.',
    );
  if (siteUrl && (new URL(siteUrl).hash || new URL(siteUrl).search)) {
    throw new Error(
      'siteUrl must be the website root, without a query or fragment',
    );
  }
  if (
    paypalUrl &&
    !['paypal.me', 'www.paypal.me', 'paypal.com', 'www.paypal.com'].includes(
      new URL(paypalUrl).hostname,
    )
  ) {
    throw new Error('paypalUrl must point directly to paypal.me or paypal.com');
  }
  return {
    siteUrl: siteUrl ? siteUrl.replace(/\/?$/, '/') : '',
    paypalUrl,
    repositoryUrl,
  };
}

function readConfig(release = false) {
  return validateConfig(
    JSON.parse(fs.readFileSync(path.join(root, 'release.config.json'), 'utf8')),
    release,
  );
}

module.exports = { root, readConfig, validateConfig };
