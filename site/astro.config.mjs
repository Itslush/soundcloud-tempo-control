import { defineConfig } from 'astro/config';
import config from '../scripts/config.cjs';

const { siteUrl } = config.readConfig();

export default defineConfig({
  site: siteUrl || undefined,
  base: siteUrl ? new URL(siteUrl).pathname : '/',
  output: 'static',
  outDir: '../dist/site',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
});
