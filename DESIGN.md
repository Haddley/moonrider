# Moon Rider — Design & Architecture

Moon Rider is a WebXR rhythm game (Beat Saber-style) that runs entirely in the browser, built with A-Frame on top of three.js. The player rides a procedurally generated curved rail through space and slices (classic), punches (punch), or just watches (ride/viewer) note blocks that are spawned from community-made Beat Saber maps streamed from beatsaver.com.

This document explains how the app works end to end. File references are `path:line` against the current source.

---

## 1. High-level architecture

```
index.html
 ├─ <script> A-Frame (pinned commit, jsdelivr CDN)     ← provides window.AFRAME + window.THREE
 └─ <script> build/build.js                            ← the app bundle (webpack)
        src/index.js  → registers 3rd-party components
                      → require.context() all src/components/*.js and src/state/*.js
                      → require('./scene.html')        ← the entire A-Frame scene as HTML

build/zip.js                                           ← separate webpack bundle, run as a Web Worker
```

Three pillars:

1. **HTML as templates** — `src/scene.html` plus `src/templates/*.html` describe the whole scene. They are processed at build time by nunjucks (`super-nunjucks-loader`), composed with `<require path="...">` (`html-require-loader`), and hot-reloaded via DOM diffing (`aframe-super-hot-html-loader`).
2. **Central state store** — `src/state/index.js` registers a single `aframe-state-component` store (~1000 lines). Components never mutate state directly; they emit DOM events on the scene, `handlers` mutate the state object, and entities update through declarative `bind__*` attributes.
3. **Component soup** — ~130 small A-Frame components in `src/components/` implement everything else: beat spawning, collision, menus, shaders, debug tooling.

---

## 2. Build system

`webpack.config.js` (Webpack 4, requires Node ≤ 12; the repo is developed on Node 11 via nvm):

- **Entries**: `build: src/index.js` → `build/build.js` (main app) and `zip: src/workers/zip.js` → `build/zip.js` (worker). `output.globalObject: 'this'` exists so the worker bundle doesn't assume `window`.
- **Loader chain for HTML** (right-to-left): `html-require-loader` (inlines `<require path>` partials, root `src/`) → `super-nunjucks-loader` (renders `{% %}`/`{{ }}` with build-time globals) → `aframe-super-hot-html-loader` (wraps the HTML in a JS module that injects it into `#app` on DOMContentLoaded and hot-swaps via `diff-dom`).
- **Nunjucks globals** (webpack.config.js:47-56): `COLORS` (the palette object from `src/constants/colors.js`, required by the config itself in Node), `DEBUG_LOG`, `DEBUG_KEYBOARD`, `DEBUG_INSPECTOR`, plus `DEBUG_AFRAME`/`HOST`/`IS_PRODUCTION` which are currently unused by any template.
- **Other loaders**: `babel-loader` + `aframe-super-hot-loader` for JS (HMR for component registrations), `webpack-glsl-loader` for `.glsl`, `style-loader`/`css-loader`, `url-loader` for images.
- **Firebase polyfill stub** (webpack.config.js:9-13): a `NormalModuleReplacementPlugin` replaces any module path matching `/firebase\/polyfill/` with `src/constants/colors.js` — a historical workaround for a firebase sub-package that failed to resolve. With the currently installed `firebase@7.24.0` nothing imports that path anymore, so the rule is inert (kept as vestigial cruft).
- **A-Frame sourcing**: A-Frame is *not* an npm dependency. The runtime comes exclusively from the pinned-commit CDN script in `index.html:17`. `vendor/aframe-master.*` (~10 MB) is an unreferenced local snapshot (dead weight that still gets deployed). `vendor/BufferGeometryUtils.js`, `CatmullRomCurve3.js`, `Curve.js` *are* used — they monkey-patch utilities onto the global `THREE` that the pinned A-Frame build lacks (`src/index.js:8`, `supercurve.js:1-2`).
- **Deploy**: `npm run deploy` → production build → stage `index.html assets build vendor CNAME` into `.ghpages/` → push to the `gh-pages` branch of `github.com/supermedium/moonrider` (hardcoded upstream; forks must change this). `CNAME` = `moonrider.xyz`. No CI; deploys are manual.

### Bootstrap order (src/index.js)

Order matters: vendored `BufferGeometryUtils` first, then third-party A-Frame components (critically `aframe-state-component` *before* `src/state/` is loaded, because `state/index.js` calls `AFRAME.registerState` at module scope), then all `src/components/`, then `src/state/`, then CSS, then `scene.html`. The scene markup is inserted on DOMContentLoaded, by which time every component it references is registered. `src/index.js` also stubs `console.time/timeEnd` to no-ops, wires the newsletter form, and force-redirects http→https on non-localhost hosts.

---

## 3. Central state

`src/state/index.js` — single store, `handlers` keyed by event name, `computeState()` derives values after every handler.

### State shape (grouped)

- **Screen flags**: `introActive`, `menuActive`, `isSearching`, `genreMenuOpen`, `playlistMenuOpen`, `optionsMenuOpen`, `difficultyFilterMenuOpen`, `isLoading` (song zip + processing), `isZipFetching`, `isSongProcessing`, `isPaused`, `isVictory`, `isGameOver`, `hasSongLoadError`, `isMenuOpening`.
- **Computed** (state/index.js:849-872): `isPlaying` (challenge loaded ∧ no menu/pause/victory/gameover/loading), `mainMenuActive` (menu open ∧ no sub-menu), `leftRaycasterActive`/`rightRaycasterActive` (menu laser hand selection), `score.active` (HUD only when in VR and not in ride mode).
- **Challenge**: `challenge` (the *playing* song: id, audio blob URL, difficulty, beatmapCharacteristic, metadata…) vs `menuSelectedChallenge` (the *staged* song in the menu). `challengeDataStore` (module-level, non-state) caches full beatsaver records by id.
- **Score**: `score`, `combo`/`maxCombo`, `beatsHit`/`beatsMissed`, `accuracyScore` (running sum of per-beat percents), `accuracy`, `rank`.
- **Search**: `search.query/results/page/url/urlPage`, `searchResultsPage` (current 6-item slice rendered with `bind-for`), `genre`, `playlist`, `favorites`.
- **Device/settings**: `inVR`, `hasVR`, `has3DOFVR`/`has6DOFVR`, `controllerType`, `activeHand`, `colorScheme` + derived color fields, `speed`.

### The binding pattern

```html
<a-entity bind__visible="menuActive"
          bind__beat-generator="challengeId: challenge.id; difficulty: challenge.difficulty; ..."
          bind-toggle__raycastable="mainMenuActive || isSearching">
```

`bind__<component>` pushes state expressions (full JS-ish expressions, not just paths) into component schemas; `bind-toggle__<component>` attaches/detaches a component on a boolean; `bind-for` + `bind-item__*` render lists (search results, difficulty options, genre grid). Components emit e.g. `this.el.sceneEl.emit('menuchallengeselect', id)` to trigger handlers.

### localStorage keys

| Key | Purpose | Note |
|---|---|---|
| `colorScheme` | theme | read at boot by both `materials.js` and `constants/colors.js` |
| `favorites-v2` | favorited songs | also read by search.js for the favorites pseudo-playlist |
| `gameMode` | VR mode choice | written/read only by `menu-mode.js`, overrides `state.gameMode` when `hasVR` |
| `moonriderusername` | leaderboard name | default "Super Zealot" |
| `hand` / `activeHand` | menu hand | **broken**: boot reads `hand`, the swap handler writes `activeHand`, so the preference never persists (state/index.js:67 vs :188) |
| `subscribeClosed` | newsletter banner | site chrome, not game state |

---

## 4. Screen flow

```
Intro ("BEGIN") ──startgame──▶ Main menu
  Main menu ──keyboardopen/genremenuopen/playlistmenuopen/optionsmenuopen──▶ sub-menus
  (song click) ──menuchallengeselect──▶ staged song + difficulty list + leaderboard fetch
  (difficulty click) ──menudifficultyselect
  (PLAY) ──playbuttonclick──▶ isLoading=true ──zip/audio pipeline──▶ isPlaying
  ──songcomplete──▶ Victory (classic/punch in VR) or straight back to menu (ride / non-VR)
  Pause: Escape / VR menu button / tab-hide ──pausegame──▶ gameMenu (resume/restart/exit)
```

- A single `menuback` handler closes *all* sub-menus at once (state/index.js:482-488).
- Game mode selection: `modes.html` shows Punch/Ride/Classic in VR, Ride/Viewer in 2D. The persisted `localStorage.gameMode` (VR only) is re-applied by `menu-mode.js` on update, making localStorage — not the state default `'ride'` — the effective source of truth in VR.
- Browser history/back button is **not** handled; `components/history.js` is dead code (never attached, and calls an undefined `updateQueryParam`). `?challenge=<id>` seeds `challenge.id` but nothing fetches that song's metadata unless it happens to be in the search cache, so arbitrary deep links are incomplete.

---

## 5. Song data pipeline

### 5.1 Search (components/search.js)

- Initial "popular" list is **bundled**: `src/lib/search.json` (~1.2 MB of raw beatsaver records) is converted and shuffled at module load — the first menu render needs no network.
- Text search (≥3 chars): `https://beatsaver.com/api/search/text/<page>?sortOrder=Rating&automapper=true&q=<query>`
- Genre: same endpoint with `&tags=<slug>` (UI names mapped to beatsaver tag slugs in search.js:113-131).
- Playlists: `https://api.beatsaver.com/playlists/id/<id>/<page>` (different host!). The `favorites` playlist is purely local (localStorage).
- Pagination is two-level: client-side pages of 6 over the fetched array; when the local cursor nears the end, the next remote page is fetched and appended (state/index.js:668-702).
- None of the search fetches have `.catch()`; failures leave the UI silently unchanged (`searcherror` exists as a handler but is never emitted).

### 5.2 Normalization (lib/convert-beatmap.js)

Flattens modern beatsaver API records into the legacy shape the rest of the app expects: unwraps playlist `{map: …}` nesting, takes `versions[0]` for `version` (hash) and `directDownload` (the CDN zip URL), rewrites the cover URL through the `beatproxy.b-cdn.net` CORS proxy (needed because thumbnails are drawn into a canvas atlas, which requires CORS-clean images), and pivots `versions[0].diffs` into a `metadata.characteristics` map that is **JSON-stringified** so it survives state binding (re-parsed in the `menuchallengeselect` handler).

### 5.3 Download & unzip (components/zip-loader.js + workers/zip.js)

On PLAY, `zip-loader` posts `{directDownload, version, bpm, …}` to the `build/zip.js` worker. The worker uses `unzip-js` to stream the zip **directly from beatsaver's CDN** and extracts:

- `.egg`/`.ogg` → audio, exposed as a `Blob` object URL,
- `info.dat` → map metadata,
- other `.dat` files → difficulty beatmaps (`JSON.parse`d, keyed `<characteristic>-<difficulty>`, with `_beatsPerMinute` stamped in from the API metadata).

The result comes back as a `'load'` message → `ziploaderend` → state stores the audio URL, `beat-generator` stores the beat data. Nothing is persisted; every play re-downloads.

Known weaknesses in this path (see §11): the worker never posts `error` or `progress` messages (failures leave the loading screen stuck; the progress ring can never advance), the "done" check races entry completion order, and every song change triggers a redundant second download because the abort message is a no-op.

*Dependency landmine*: `unzip-js` → `blob-slicer` calls `stream.destroy()`, which only exists in `readable-stream` v2+. `blob-slicer` doesn't declare the dep, so `readable-stream@^2.3.8` is pinned as a direct dependency purely to hoist v2 to the top of node_modules. Removing it breaks song unzipping.

### 5.4 Beatmap format & v3→v2 conversion

The game consumes the **v2** Beat Saber format:

- `_notes[]`: `_time` (beats), `_lineIndex` (column 0-3), `_lineLayer` (row 0-2), `_type` (0 red / 1 blue / 3 mine), `_cutDirection` (0-7 directions, 8 = any/dot).
- `_obstacles[]`: `_time`, `_lineIndex`, `_type` (1 = ceiling), `_duration`, `_width`.
- `_events[]`: stage lighting (type 0 background/moon, 1 stars, 2/3 curve colors, 4 floor, 8/9 tube pulse, 12/13 side glow; value = palette index).

v3-format maps are converted back to v2 **on the main thread** in `beat-generator.js:450-495` (`convertBeatData_320_to_2xx`) — *not* in the zip worker. The conversion maps `colorNotes`→`_notes`, `bombNotes`→`_notes` with `_type:3`, `obstacles`→`_obstacles`, but **drops all lighting** (`_events` is hardcoded `[]`), ignores arcs/chains, and reads a nonexistent `obstacle._type` field (so v3 ceiling walls likely always render as floor walls).

### 5.5 Previews & covers

- Hovering a song plays a preview streamed straight from `https://cdn.beatsaver.com/<hash>.mp3` (song-preview.js:25). `src/utils.js`'s `previews.moonrider.xyz` helper is dead code from the pre-CDN era.
- Cover thumbnails are drawn into a 512-px vertical canvas atlas (6 slots) by `search-thumbnail-atlas.js`, via the `beatproxy.b-cdn.net` proxy.

### 5.6 Leaderboard (components/leaderboard.js)

Firebase Firestore, collection `scores`, docs `{challengeId, difficulty, gameMode, score, accuracy, username, time}`; top-10 query ordered `score desc, time asc`. Scores submit only for VR victories. The username passes a profanity check (`profane-words` package **plus** a crude substring regex that also blocks innocent names containing "ass" etc. — and the UI emits `leaderboardscoreadded` regardless, so a blocked write looks successful). Firebase project/keys are set by nunjucks variables at the top of `scene.html`; the `true and 'moonrider-prod' or 'moonrider-dev'` expression always picks **prod**, including on local dev servers.

### External services summary

| Host | Used for |
|---|---|
| `beatsaver.com/api/search/text/…` | text/genre search |
| `api.beatsaver.com/playlists/…` | playlist contents |
| `cdn.beatsaver.com` | song zips, preview mp3s |
| `beatproxy.b-cdn.net` | CORS proxy for cover images |
| Firestore (`moonrider-prod`) | leaderboards |
| jsdelivr CDN | the A-Frame build itself |
| `supermedium.com/mail/subscribe` | newsletter form |

---

## 6. Core game loop

### 6.1 Timing model

Constants (beat-generator.js:9-17): `BEAT_ANTICIPATION_TIME = 1.1 s`, `BEAT_PRELOAD_TIME = 1.1 s`, `SWORD_OFFSET = 1.5 m`, `PUNCH_OFFSET = 0.5 m`, `BEAT_FORWARD_TIME = 3500 ms` desktop / 2000 mobile, `WALL_FORWARD_TIME = 10000/7500 ms`.

- **Spawning** is driven by the Web Audio clock: each tick, any note whose `_time × msPerBeat` falls within `BEAT_FORWARD_TIME` of `song.getCurrentTime()` is pulled from a pool and placed on the curve.
- **Placement** bakes anticipation into *position*: a note's curve position is its musical time **plus** `(weaponOffset/speed + BEAT_ANTICIPATION_TIME)` seconds of travel (beat-generator.js:299-307). Because the weapon extends `weaponOffset` meters ahead of the rig moving at constant `speed`, the block physically meets the blade at the intended musical moment. Hits are then resolved by real 3D collision, not clock matching.
- **The preload trick**: when a song loads, `beat-generator` runs ~1.1 s of ticks on a synthetic clock *before audio starts* (`preloadTime`), spawning the first beats; meanwhile the rig (already enabled by `isPlaying`) travels `speed × 1.1` meters. Only when preloading finishes (`beatloaderpreloadfinish` → `isBeatsPreloaded`) does `song.startAudio()` run. The head start exactly cancels the anticipation offset baked into every note.
- **Pause** works by suspending the actual `AudioContext` — `getCurrentTime()` is `context.currentTime − songStartTime` and the context clock freezes while suspended, so no offset bookkeeping is needed. The rig and beat-generator freeze in lockstep because both are gated on `isPlaying`.
- **Two-clock caveat**: spawning uses the audio clock, but the rig's position integrates `requestAnimationFrame` deltas (`supercurve.js:301-303`). The curve length is authored as `speed × songDuration`, so the two stay aligned *by construction*, but nothing re-syncs them; long frame hitches can drift visuals against audio.

### 6.2 The supercurve

`components/supercurve.js` generates the serpentine rail per song: points every 100 m with random ±10 m X/Y jitter, a final point extrapolated so the arc length is exactly `speed × songDuration` (+200 m of overshoot padding), then a `CatmullRomCurve3` tessellated into a 350-sample, 3 m-wide triangle-strip ribbon. Key API: `getPointAt(songPercent)`, `getPositionRelativeToTangent()` (offset in the curve's moving frame — used for the ribbon edges, wall geometry, and beat lane offsets), `alignToCurve()` (orient an object down-track). `supercurve-follow` walks the camera rig along it at constant speed and exposes `songProgress` for hit-window checks.

### 6.3 Entity pooling

All gameplay entities come from A-Frame `pool__*` components declared on the scene (scene.html:34-58): `pool__beat-{arrow,dot}-{blue,red}`, `pool__beat-mine`, `pool__plume-*` (ride mode), `pool__beat-broken-*`/`pool__punch-broken-*` (explosion fragments), `pool__wall`, `pool__tunnels`, FX pools. Spawn: `requestEntity()` → `setupBeat()` → `onGenerate()` registers with `beat-system`; return: on hit/miss/`cleargame`, entities are hidden, moved to `(0,0,−9999)`, paused, and returned. A `setTimeout` fallback covers the mixin-init race when a pooled entity's component isn't ready yet (beat-generator.js:282-287).

### 6.4 Game modes

| Mode | Entities | Collision | Scoring |
|---|---|---|---|
| classic | beats (arrow/dot/mine) + walls | swept blade triangle vs AABB, direction-checked | speed + angle |
| punch | beats forced to dot type | fist AABB overlap | base + speed, no direction |
| ride | plumes (cosmetic), no walls | none — `beat-system` skips ride entirely | none; no victory screen |
| viewer | classic beats, 2D | auto-hit (`autoHit()`, 90% random success) | not submitted |

---

## 7. Input, weapons, collision

- Both hand entities always contain all three weapon rigs (blade / fist / hand-star); game mode just toggles visibility and `enabled` bindings (scene.html:153-276). Left is always red, right always blue (`WEAPON_COLORS` in beat.js).
- **Controller detection**: the native `controllerconnected` event sets both `controller.js`'s per-hand cursor config (button mappings per headset type) and `state.controllerType`/`has6DOFVR`.
- **Blade collision** (blade.js:83-126): a swept-triangle test — triangles formed from the blade tip/handle positions across the current and previous frame are tested against the beat's AABB in the beat's local space (points scaled ×1.75 to enlarge the effective hitbox; extra padding for side lanes). Requires stroke speed ≥ 1 m/s. Direction correctness for arrow beats: swing-direction · required-direction dot product ≥ 0.625 (~50°) to count; ≥ 0.97 (~15°) earns the "supercut" bonus.
- **Punch collision** (punch.js:43-51): plain AABB-vs-AABB with generous fixed padding (ignores the beat's scale/rotation — masked by punch beats always being dot-type).
- **Wrong-weapon hits** only register above a minimum speed (15 m/s classic / 2 m/s punch) so incidental brushes don't punish.
- **Menu interaction**: per-hand raycasters + `cursor` with a retractable laser (`cursor-laser.js`) while any menu is open; only the `activeHand` shows a laser, swappable via any button on the *other* hand (`hand-swapper` → `activehandswap`). Non-VR uses A-Frame's `cursor="rayOrigin: mouse"` fallback. Clickable regions are invisible padded geometry from `raycaster-target.js`.
- **Misses**: a beat that travels 1.25 m past the rig un-hit emits `beatmiss`. Mines only penalize when hit. Wall contact emits `wallhitstart` (ducks the audio, resets combo).

## 8. Scoring

Per hit, two numbers: raw `score` (uncapped, added to the total) and `percent` (accuracy contribution, capped at 100).

- **Blade**: up to 30 from stroke speed (bonus range up to 50 raw for >10 m/s swings) + up to 70 from swing-angle precision (flat 70 for dot beats). A perfect fast swing can bank ~120 raw points while accuracy caps at 100.
- **Punch**: 60 base + up to 40 from speed (raw bonus to 70). No direction component (explicitly noted as a TODO in beat.js:602).
- `beathit` increments combo, `beatmiss`/`beatwrong`/`minehit`/`wallhitstart` reset it. Accuracy = mean per-beat percent over all attempted beats (misses count 0).
- Ranks at song end (state/index.js:749-762): S ≥ 97, A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F. Rendered as extruded 3D text (see §9).
- The **multiplier ring** UI (`multiplier-ring.js`, tiers ×1/×2/×4/×8 at combos 0/2/6/14) is cosmetic: nothing ever computes a multiplier into the actual score.
- The **damage/game-over system is disabled**: `takeDamage()` has the damage increment commented out ("No damage for now"), so normal play can never reach `isGameOver` — misses only reset the combo.

---

## 9. Rendering & visuals

- **Materials system** (`components/materials.js`): an A-Frame system that builds ~25 shared THREE materials once (weapons, beats, tunnel, aurora, moon, stars, plumes, glow strips…) plus canvas-generated textures (beat gradient, fist trim, colorized envmap). Entities opt in with `materials="name: tube"`; shader components created elsewhere register back into the system (`registerPanel`, `registerCurve`). A central `tick()` drives all time uniforms. This sharing is the main draw-call/GPU-state optimization.
- **Color schemes**: 9 palettes in `src/constants/colors.js`, persisted in localStorage, switched by `setColorScheme()` which re-tints every registered material and regenerates canvas textures. Two schemes have typo'd `primarybright` keys (`rgb`, `cheetah`) and silently render parts white.
- **Stage event colors**: `stage-colors.js` is a second, orthogonal system that maps beatmap `_events` codes to pre-registered scene animations (background, side glows, curve segments, star tint) at runtime.
- **Shaders**: all GLSL lives in `src/components/shaders/*.glsl` (loaded via webpack-glsl-loader) **except** `supercutfx-shader.js`, whose GLSL is inline in a JS template literal — a JS formatter once stripped its semicolons and broke rendering (fixed in `cb97d3e`); keep formatters away from it or move the GLSL into files. Highlights: `supercurve` (the animated track surface with fog + start/end fade), `tunnel`/`aurora`/`moon`/`home` (backdrop), `wall` (env-mapped obstacle with glitch flash at weapon contact points), `weapon`/`weaponHandle`/`fistWeapon` (blades/fists), `panel` (SDF rounded-rect menu panels), `ring`/`rings` (HUD + multiplier), `plume`/`cutfx`/`supercutfx` (FX).
- **render-order**: transparency layering is a manual painter's list declared once on the scene (scene.html:65, `stage → … → menu → menutext → … → victory → stepback`); `aframe-render-order-component` maps names to `renderOrder`. Beats additionally get fractional per-instance orders so farther blocks draw behind nearer ones. Two templates reference layer names that don't exist (`menuText`, `menuitemtext`), silently dropping those texts out of the ordering.
- **3D text**: `TextGeometry`/`FontLoader` are vendored in `src/lib/` (copied from three examples, since the pinned A-Frame's THREE no longer ships them). Only used for the victory rank letter, with the Viga typeface (`assets/fonts/`).
- **GPU preloading** (`gpu-preloader.js`): 1 s after start, force-uploads every registered texture to the GPU (via `renderer.setTexture2D`) so first-reveal of menus/FX doesn't stutter. Skips (with a console warning) any image not yet decoded — a race on slow connections.

---

## 10. Debug & URL parameters

`?debugcontroller=<mode>`… — as documented in README/CLAUDE.md, plus the full set:

| Param | Effect |
|---|---|
| `?skipintro=true` | skip intro screen |
| `?challenge=<id>` | seed challenge id (only works for cached/popular songs) |
| `?debugstate=loading,victory,gameover,gameplay` | jump to screens (uses a hardcoded debug challenge) |
| `?debugvr=true` | fake `hasVR`/`inVR` on desktop |
| `?debug` / `?debug=oculus` + `?type={classic,punch,ride}` | visible debug controllers, keyboard-move (shift/ctrl + h/j/k/l) |
| `?debugbeatpositioning={classic,punch}` | spawn all beat positions at once |
| `?debugstage` | on-screen stage lighting trigger buttons |
| `?skip=<ms>` | jump into the song (parsed in ms by beat-generator, ÷1000 by song.js — keep in sync) |
| `?synctest` | auto-hit every beat, for AV-sync checking |
| `?debugmines`, `?dot`, `?debug-song-time`, `?mute`, `?stats=true`, `?headfist` | assorted toggles |

`console-shortcuts.js` exposes `window.state` and `window.scene` for live inspection. `?inspector` only exists in builds made with `DEBUG_INSPECTOR=true`.

---

## 11. Known issues & quirks (code review, 2026-07)

Confirmed findings from a full-codebase review, roughly by severity. None are fixed yet unless noted.

**Functional bugs**
1. **Worker never reports errors or progress** (`workers/zip.js` — only ever posts `'load'`): a failed song download leaves the loading screen stuck forever, and the progress ring (`zip-loader.js:72`) can never move.
2. **Double download on song change** (`zip-loader.js:23-50`): the "abort" message is never handled by the worker and itself carries the new URL, so each selection change kicks off two full downloads; the mislabeled one is discarded by a version guard.
3. **Worker "done" check races entry order** (`workers/zip.js:70-94`): the `'load'` message can fire multiple times with an incomplete difficulty set depending on unzip stream completion order.
4. **Difficulty filter does nothing** (`search.js`): the UI is wired (and partially commented out in `menu.html:292-312`), but since the Algolia→beatsaver migration the filter value is never sent to the API.
5. **v3 obstacle `_type` misread** (`beat-generator.js:487`): reads `obstacle._type` from v3 data where the field doesn't exist → v3 ceiling walls likely always render as floor walls. v3 conversion also drops all lighting events, arcs, and chains.
6. **Hand preference never persists**: reads `localStorage.hand`, writes `localStorage.activeHand` (state/index.js:67 vs :188).
7. **`Math.random > 0.5`** (`beat.js:406`): function reference compared to number — beat warm-up spin direction is never randomized.
8. **Palette typos** (`constants/colors.js:84,94`): `primarYBRIGht`/`primarYBright` break the `rgb` ("Mint Choco") and `cheetah` ("Cheetah SoL") schemes — left fist renders white.
9. **render-order name mismatches**: `menuText` (menu.html:177,183,188) and `menuitemtext` (victory.html ×7) don't exist in the scene's order list → those texts get `renderOrder: undefined` (victory-screen text z-fighting risk). Also a stray `k` typo in victory.html:9.
10. **Curve extrapolation bug** (`supercurve.js:207-217`): out-of-range percents scale a unit tangent by the raw fraction instead of the overshoot distance — the final beats/walls of every song are slightly misplaced.
11. **Dev serves prod leaderboard** (`scene.html:4-5`): `true and 'moonrider-prod' or 'moonrider-dev'` always picks prod; local dev writes to the live Firestore.
12. **Profanity filter false positives** (`leaderboard.js:6`): substring regex blocks innocent usernames (anything containing "ass"…), and the UI reports success even when the write was silently dropped.
13. **No `.catch()` on search/pagination fetches**; `searcherror` handler exists but is never emitted. Undeclared loop variable `i` leaks a global (state/index.js:696).
14. **`song.js:87`**: `gainNode.value` should be `gainNode.gain.value` (currently a no-op, masked by a later `setValueAtTime`).
15. **Invalid redirect URL** (`src/index.js:83`): `https://supermedium/subscribe/` is missing `.com`.
16. **`?skipintro` truthiness mismatch**: `debug-intro.js` treats any value as true; state requires the literal `'true'` — `?skipintro=false` half-skips.
17. **Leaderboard ignores `beatmapCharacteristic`** (acknowledged TODO): different characteristics sharing id+difficulty collide on one board.
18. **`menuchallengeselect` can throw** on maps with no standard-characteristic difficulties (`menuDifficulties[0]` unguarded, state/index.js:537-541).

**Dead code (safe to delete)**
- `components/history.js` (never attached; calls undefined `updateQueryParam`), `components/pause.js`, `components/toggle-pause-play.js`, `headfist.js` (URL-gated experiment).
- `src/utils.js` `getS3FileUrl` + the `previews.moonrider.xyz` constant; `jsonParseClean`/`jsonParseLoop` in zip-loader.js; `queryObject`/`filters` Algolia leftovers in search.js; `hash` plumbing in zip-loader/worker; worker's module-scope `difficulties`/`xhrs`/`short`; `checkGameOver`/damage system; the `off` field in every color scheme; the commented-out cutFX canvas path in materials.js; the firebase-polyfill webpack stub; unused nunjucks globals (`DEBUG_AFRAME`, `HOST`, `IS_PRODUCTION`); `text-geometry.js`'s dead rawgit default font URL; `wall.js:1` imports a non-exported `SIZES`.
- `vendor/aframe-master.*` (~10 MB) is never referenced but ships with every deploy.

**Fragile patterns to be aware of**
- Two independent clocks (audio vs rAF) assumed never to drift (§6.1).
- Restart flow relies on implicit event choreography across song.js/beat-generator/state; beat indices only reset on `challengeId` *change* (beat-generator.js:441-445).
- `curve-follow-rig-reset` pokes `supercurve-follow.curveProgress` directly.
- `debug-beat-positioning` depends on `window.scene` being set by `console-shortcuts` first.
- Maps with >256 obstacles silently lose **all** walls (beat-generator.js:174-177).
- `beat-hit-sound.js` pitch selection uses exact float equality against layer heights; its `playSound` is called with shifted arguments that work by accident.
- Wall lifecycle ticks are throttled to 1 Hz — up to ~1 s of wall raycastability jitter.
- `vertex-colors-buffer.js` defaults `itemSize: 3` despite its own TODO saying glTF needs 4.
- The inline GLSL in `supercutfx-shader.js` is the only shader a JS formatter can silently destroy.
