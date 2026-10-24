#!/usr/bin/env node
/**
 * Download timed lyrics from LRCLIB (https://lrclib.net) into assets/lyrics/<id>.lrc.
 *
 * Usage:
 *   node scripts/fetch-lyrics.js <beatsaver-id> ["<song title>" "<artist>"] [--out <file>]
 *
 * With only an id, the title and artist are read from the beatsaver map metadata.
 * Files are gitignored and left out of `npm run deploy`; keep them on this machine.
 * LRCLIB is not licensed by the rights holders, so this is for private experiments only.
 * Timings are for the original recording: tune with an [offset:ms] line at the top of the file.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
let outFile;
if (outIndex !== -1) { outFile = args[outIndex + 1]; args.splice(outIndex, 2); }
const [id, titleArg, artistArg] = args;

if (!id) {
  console.error('Usage: node scripts/fetch-lyrics.js <beatsaver-id> ["<title>" "<artist>"] [--out <file>]');
  process.exit(1);
}

async function getJson (url, attempts = 3) {
  const res = await fetch(url, {headers: {'User-Agent': 'moonrider-local-lyrics (private use)'}});
  if (res.status >= 500 && attempts > 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    return getJson(url, attempts - 1);
  }
  if (!res.ok) { throw new Error(`${res.status} ${res.statusText} for ${url}`); }
  return res.json();
}

(async function main () {
  let title = titleArg;
  let artist = artistArg;
  let duration;

  const map = await getJson(`https://api.beatsaver.com/maps/id/${encodeURIComponent(id)}`);
  duration = map.metadata.duration;
  if (!title) {
    // Beatsaver names are often "Song (Mapper tag)" and the artist can be the real one.
    title = map.metadata.songName.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
    artist = artist || map.metadata.songAuthorName;
  }
  console.log(`Searching LRCLIB for "${title}" by "${artist}" (map ${id}, ${duration}s)`);

  const results = await getJson(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist || '')}`);
  const synced = results.filter(r => r.syncedLyrics);
  if (!synced.length) {
    console.error('No synced lyrics found. Try different title/artist arguments.');
    process.exit(2);
  }
  // Prefer the version whose length is closest to the map's audio.
  synced.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  const best = synced[0];
  console.log(`Using: "${best.trackName}" by ${best.artistName} (${Math.round(best.duration)}s, map is ${duration}s)`);
  if (Math.abs(best.duration - duration) > 3) {
    console.log('Note: durations differ, so timings may need an [offset:ms] tag or edits.');
  }

  const target = outFile || path.join(__dirname, '..', 'assets', 'lyrics', `${id}.lrc`);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, best.syncedLyrics.trim() + '\n');
  console.log(`Saved ${target}`);
})().catch(err => { console.error(err.message); process.exit(1); });
