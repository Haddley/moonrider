# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Moon Rider is a WebXR rhythm game (Beat Saber-style) built with A-Frame, playable in-browser at supermedium.com/moonrider. Song maps are streamed from beatsaver.com.

## Commands

Requires old Node/npm: `engines` pins node <= 12.18.3 and npm <= 6.14.6 (README recommends Node v11). Node 11.15.0 is installed via nvm (as an x64 build running under Rosetta, since Node 11 has no arm64 binaries):

```
nvm use 11        # before npm install / npm run start
nvm use system    # switch back to Homebrew Node (v25)
```

The nvm default alias is `system`, so new shells start on Node 25.

A fresh checkout has no `node_modules`, so run `nvm use 11 && npm install` once before `npm run start`/`npm run build` (otherwise the build fails with `cross-env: command not found`). The install prints many `npm WARN deprecated` messages — normal for this old dependency tree.

`npm install` under npm 6 can silently skip `ansi-html-community` (a declared dependency of `webpack-dev-server@3.11.3`). If `npm run start` fails to compile with `Module not found: Can't resolve 'ansi-html-community'`, run `npm install --save-dev ansi-html-community@0.0.8` to fix it (already pinned in `devDependencies`).

- `npm run start` — webpack-dev-server (HTTPS) with hot module replacement at `https://localhost:3000`. Serves over HTTPS with a self-signed cert (via `--https`), which WebXR requires for a secure context — the browser shows a cert warning you must accept ("Advanced → Proceed"). For headset/other-device testing use `https://<your-LAN-IP>:3000`. `localhost` over plain HTTP is also a secure context, but the `--https` flag makes the LAN URL work too.
- `npm run build` — production build (outputs `build/build.js` and `build/zip.js`). Emits several harmless warnings that are **not** failures: `DEBUG_LOG` environment variable undefined, `mode` option not set (webpack falls back to `production`, which is correct), and asset/entrypoint size limit exceeded (`build.js` is ~2.4 MiB — over webpack's 244 KiB advisory threshold, expected for this A-Frame/THREE bundle).
- `npm run lint` — semistandard (semicolons required; `AFRAME` and `THREE` are declared globals)
- `npm run lint:fix` — auto-fix lint issues
- `npm run deploy` — build and push to GitHub Pages

There is no test suite. Manual testing uses URL parameters:

- `?debugcontroller={classic,punch,ride}` — show controllers, move with shift/ctrl + h/j/k/l
- `?debugbeatpositioning={classic,punch}` — show all note positionings
- `?debugstate={loading,victory}` — jump to a screen
- `?skipintro=true` — skip intro screen
- `?challenge=<id>` — load a specific song directly

## Architecture

Webpack 4 builds two entry points: `src/index.js` (main app → `build/build.js`) and `src/workers/zip.js` (web worker → `build/zip.js`). `src/index.js` registers all third-party A-Frame components, then `require.context`-loads everything in `src/components/` and `src/state/`, then requires `src/scene.html`.

### HTML as templates

`src/scene.html` is the entire A-Frame scene, processed by super-nunjucks-loader (nunjucks syntax like `{% set %}`, `{% if %}` works) with hot reload via aframe-super-hot-html-loader. Sub-templates live in `src/templates/` (menu, victory, loading, etc.) and are pulled in with html-require-loader. Firebase project/keys for the leaderboard are set via nunjucks variables at the top of `scene.html`.

### Central state (aframe-state-component)

`src/state/index.js` (~1000 lines) is the single source of truth. The pattern:

1. Components emit events on the scene (e.g. `this.el.emit('challengeset', ...)`)
2. `handlers` in `state/index.js` mutate the state object
3. Entities declare `bind__<component>="prop: state.path"` attributes in `scene.html`/templates and update automatically

Game modes (`classic`, `punch`, `ride`, plus viewer) branch behavior throughout components via `state.gameMode`.

### Song loading pipeline

1. `components/search.js` queries the beatsaver.com API (search, playlists, genre tags)
2. `lib/convert-beatmap.js` normalizes current beatsaver API responses into the legacy shape the rest of the code expects (flattens `versions[0]`, builds `metadata.characteristics`, proxies cover images through `beatproxy.b-cdn.net`)
3. On song select, `components/zip-loader.js` posts to the `build/zip.js` web worker, which downloads and unzips the map (audio + beatmap JSON); v3 beatmaps are converted back to v2 format (see `d7241d8`). The worker's `unzip-js` → `blob-slicer` calls `this.destroy()` on a `readable-stream`, which only exists in v2+. `readable-stream@^2.3.8` is therefore a direct dependency purely to hoist v2 to the top level (blob-slicer declares no `readable-stream` of its own); without it, song unzip crashes with `TypeError: this.destroy is not a function`. Do not remove it.
4. `components/beat-generator.js` reads beatmap events and spawns beats/walls/mines from `pool__*` entity pools defined on the scene, timed by `BEAT_ANTICIPATION_TIME`/`BEAT_FORWARD_TIME`
5. `components/supercurve.js` defines the curved track everything (beats, walls, camera rig) travels along; `components/song.js` drives audio playback and syncs game state to it

Song previews come from `https://previews.moonrider.xyz` (see `src/utils.js`).

### Other notable pieces

- `src/constants/colors.js` — color palettes (also imported by `webpack.config.js`, and abused as a stub for the firebase polyfill via NormalModuleReplacementPlugin)
- `src/lib/TextGeometry.js` / `FontLoader.js` — copied from super-three because A-Frame's bundled THREE no longer includes them
- A-Frame itself is not an npm dependency — `index.html` loads a specific aframe-master commit from the jsdelivr CDN; `vendor/` holds THREE modules required into the bundle (`BufferGeometryUtils`, `CatmullRomCurve3`, `Curve`) plus a local aframe copy
- `components/leaderboard.js` — Firebase Firestore-backed leaderboards
- Custom shaders live in `src/components/shaders/` and `*-shader.js` components; GLSL files load via webpack-glsl-loader
