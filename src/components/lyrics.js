/* global fetch */
/**
 * Show timed lyrics floating above the track.
 *
 * Looks for `assets/lyrics/<challengeId>.lrc`. A missing
 * file just means no lyrics. LRC format: `[mm:ss.xx] text`, an empty text hides the line.
 *
 * Timing fix: a `[offset:ms]` tag in the file. Positive values show lyrics earlier
 * (per the LRC spec), negative later.
 */
const LYRICS_DIR = 'assets/lyrics/';
// Where the lyrics float relative to the camera rig.
const DEFAULT_HEIGHT = 1;
const DEFAULT_DISTANCE = 10;
const ID_LABEL_GAP = 0.6;
const LRC_LINE = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;

function parseLrc (text) {
  const lines = [];
  lines.offset = 0;
  text.split(/\r?\n/).forEach(row => {
    const offsetMatch = row.trim().match(/^\[offset:\s*(-?\d+)\]/i);
    if (offsetMatch) { lines.offset = parseInt(offsetMatch[1], 10) / 1000; return; }
    const match = row.trim().match(LRC_LINE);
    if (!match) { return; }
    lines.push({t: (parseInt(match[1], 10) * 60) + parseFloat(match[2]), text: match[3].trim()});
  });
  const offset = lines.offset;
  lines.sort((a, b) => a.t - b.t);
  lines.offset = offset;
  return lines;
}

AFRAME.registerComponent('lyrics', {
  schema: {
    challengeId: {default: ''},
    colorSecondaryBright: {default: '#FFF'},
    enabled: {default: true},
    isPlaying: {default: false}
  },

  init: function () {
    this.lines = [];
    this.index = -1;
    this.loadedFor = '';
    this.textEl = null;
    this.idEl = null;
    this.status = 'none';  // 'loading', 'found', or 'none'.
    this.height = DEFAULT_HEIGHT;
    this.distance = DEFAULT_DISTANCE;
  },

  /**
   * Create the floating text entity once the camera rig exists.
   */
  ensureTextEl: function () {
    if (this.textEl) { return this.textEl; }
    const rigEl = this.el.sceneEl.querySelector('#cameraRig');
    if (!rigEl) { return null; }
    const textEl = this.textEl = document.createElement('a-entity');
    textEl.setAttribute('mixin', 'font');
    textEl.setAttribute('position', `0 ${this.height} -${this.distance}`);
    textEl.setAttribute('text', {
      align: 'center',
      anchor: 'center',
      baseline: 'center',
      color: '#fff',
      width: 14,
      wrapCount: 40,
      value: ''
    });
    textEl.setAttribute('render-order', 'menutext');
    textEl.setAttribute('visible', false);
    rigEl.appendChild(textEl);

    // Song id (the lyrics file name) shown above the lyrics.
    const idEl = this.idEl = document.createElement('a-entity');
    idEl.setAttribute('mixin', 'font');
    idEl.setAttribute('position', `0 ${this.height + ID_LABEL_GAP} -${this.distance}`);
    idEl.setAttribute('text', {align: 'center', anchor: 'center', baseline: 'center', color: '#aaa', width: 9, wrapCount: 70, value: ''});
    idEl.setAttribute('render-order', 'menutext');
    idEl.setAttribute('visible', false);
    rigEl.appendChild(idEl);
    return textEl;
  },

  update: function (oldData) {
    const data = this.data;
    if (data.challengeId !== oldData.challengeId) {
      this.load(data.challengeId);
    }
    if (data.colorSecondaryBright !== oldData.colorSecondaryBright && this.textEl) {
      this.textEl.setAttribute('text', 'color', data.colorSecondaryBright);
    }
    if (!data.enabled || !data.isPlaying) { this.show(''); }
    this.updateId();
  },

  updateId: function () {
    const data = this.data;
    const textEl = this.ensureTextEl();
    if (!textEl) { return; }
    const visible = !!(data.enabled && data.isPlaying && data.challengeId);
    let label = `Song ID: ${data.challengeId}`;
    if (this.status === 'none') { label += `\nNO LYRICS FOUND - run: node scripts/fetch-lyrics.js ${data.challengeId}`; }
    this.idEl.setAttribute('text', 'value', visible ? label : '');
    this.idEl.setAttribute('visible', visible);
  },

  load: function (challengeId) {
    this.lines = [];
    this.index = -1;
    this.show('');
    this.loadedFor = challengeId;
    this.status = 'loading';
    const name = challengeId;
    if (!name) { this.status = 'none'; this.updateId(); return; }
    fetch(LYRICS_DIR + encodeURIComponent(name) + '.lrc')
      .then(res => (res.ok ? res.text() : ''))
      .then(text => {
        if (this.loadedFor !== challengeId) { return; }  // Stale.
        this.lines = text.trim().charAt(0) === '<' ? [] : parseLrc(text);  // HTML means a 404 page.
        this.status = this.lines.length ? 'found' : 'none';
        this.updateId();
      })
      .catch(() => {
        if (this.loadedFor === challengeId) { this.status = 'none'; this.updateId(); }
      });
  },

  show: function (value) {
    if (this.shown === value) { return; }
    const textEl = this.ensureTextEl();
    if (!textEl) { return; }
    this.shown = value;
    textEl.setAttribute('text', 'value', value);
    textEl.setAttribute('text', 'color', this.data.colorSecondaryBright);
    textEl.setAttribute('visible', !!value);
  },

  tick: function () {
    const data = this.data;
    const lines = this.lines;
    if (!data.enabled || !data.isPlaying || !lines.length) { return; }
    const song = this.el.components.song;
    if (!song || !song.isAudioPlaying) { return; }

    const time = song.getCurrentTime() + (lines.offset || 0);
    let index = this.index;
    if (index >= 0 && lines[index].t > time) { index = -1; }  // Restarted / seeked back.
    while (index + 1 < lines.length && lines[index + 1].t <= time) { index++; }
    this.index = index;
    const text = index >= 0 ? lines[index].text : '';
    this.show(text);
  }
});
