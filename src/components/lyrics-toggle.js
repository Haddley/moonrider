AFRAME.registerComponent('lyrics-toggle', {
  events: {
    click: function () {
      this.el.sceneEl.emit('lyricstoggle', null, false);
    }
  }
});
