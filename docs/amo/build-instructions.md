# Build instructions for AMO reviewers

This document describes how to rebuild the submitted Firefox package from the
source archive.

## Environment

- Ubuntu 24.04 (the default AMO reviewer environment)
- Node.js 24.x (tested with 24.14.0; Node.js 22.13+ is also supported)
- npm 11.x (the version bundled with Node.js 24)
- No network access is required after `npm ci`

## Build

```bash
npm ci
npm run build:firefox
```

`npm run build:firefox` runs `tsc --noEmit && vite build` and then
`scripts/build-firefox.mjs`. The resulting extension is in `dist-firefox/`.

Expected output:

- `dist-firefox/manifest.json` — Firefox manifest, version `0.4.1`;
- `dist-firefox/service-worker-loader.js` — background entry;
- `dist-firefox/src/sidepanel/index.html` — sidebar panel;
- `dist-firefox/generated/page-script.js` and `dist-firefox/generated/content.js`
  — MAIN-world collector and isolated-world bridge;
- `dist-firefox/icons/` — add-on icons.

## Generated files

`public/generated/page-script.js` and `public/generated/content.js` are not part
of the source archive. They are produced by the `wpa-injected-scripts` plugin in
`vite.config.ts` using esbuild, from:

- `src/content/page-script.ts`
- `src/content/index.ts`

The sources are included, so the build is self-contained.

## Verify the result

```bash
npx web-ext lint --source-dir dist-firefox
```

Expected result: 0 errors and 2 `UNSAFE_VAR_ASSIGNMENT` warnings from the
minified React DOM bundle. The add-on does not evaluate user-controlled HTML.

You can also compare the built manifest and file list with the submitted zip:

```bash
node -e "console.log(require('./dist-firefox/manifest.json'))"
find dist-firefox -type f | sort
```

## Package metadata

- Add-on ID: `web-performance-auditor@wwsxdc.github.io`
- Version: `0.4.1`
- Minimum Firefox: 142.0
- License: MIT (see `LICENSE`)
- Lockfile: `package-lock.json` is included; use `npm ci`, not `npm install`.
