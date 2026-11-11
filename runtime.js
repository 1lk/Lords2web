// Host side of the recompiled game: instantiates lords2.wasm, provides its imports, feeds it the original data,
// converts the 8-bit paletted display to RGBA, and mixes the DirectSound buffers into Web Audio.

export const EV = { MOVE: 1, LDOWN: 2, LUP: 3, RDOWN: 4, RUP: 5, KEYDOWN: 6, KEYUP: 7, CHAR: 8, FOCUS: 9, QUIT: 10, SYSKEYDOWN: 11, SYSKEYUP: 12 };

export class Runtime {
  constructor(opts = {}) {
    this.onLog = opts.onLog || (() => {});
    this.onCursor = opts.onCursor || (() => {});
    this.onCommit = opts.onCommit || (() => {});
    this.ex = null;
    this.mem = null;
    this._buf = null;
    this._u8 = null;
    this.timeOffset = 0;       // subtracted from performance.now(): lets us "stop the clock" while the page is hidden
    this.exitCode = 0;
    this.audio = null;
  }

  get u8() {
    if (this._buf !== this.mem.buffer) { this._buf = this.mem.buffer; this._u8 = new Uint8Array(this._buf); }
    return this._u8;
  }
  cstr(p) { const u = this.u8; let e = p; while (u[e]) e++; return new TextDecoder('latin1').decode(u.subarray(p, e)); }
  now() { return performance.now() - this.timeOffset; }
  peek8(addr) { return this.u8[addr]; }
  peek32(addr) { const u = this.u8; return (u[addr] | (u[addr + 1] << 8) | (u[addr + 2] << 16) | (u[addr + 3] << 24)) >>> 0; }

  async load(wasmSource) {
    const env = {
      js_log: (p) => this.onLog(this.cstr(p)),
      js_now: () => this.now(),
      js_epoch: () => Date.now(),
      js_file_commit: (name, data, size) => this.onCommit(this.cstr(name), this.u8.slice(data, data + size)),
      js_set_cursor: (id) => this.onCursor(id),
    };
    let inst;
    if (wasmSource instanceof Response || typeof wasmSource === 'string') {
      const resp = typeof wasmSource === 'string' ? await fetch(wasmSource) : wasmSource;
      if (WebAssembly.instantiateStreaming && resp.headers.get('content-type') === 'application/wasm') inst = (await WebAssembly.instantiateStreaming(resp, { env })).instance;
      else inst = (await WebAssembly.instantiate(await resp.arrayBuffer(), { env })).instance;
    } else inst = (await WebAssembly.instantiate(wasmSource, { env })).instance;
    this.ex = inst.exports;
    this.mem = this.ex.memory;
  }

  // image: flat PE image (Uint8Array); files: Map(NAME -> bytes), later maps override earlier ones.
  start(image, ...fileMaps) {
    const ex = this.ex;
    this.u8.set(image, 0x400000);
    for (const files of fileMaps) {
      for (const [name, data] of files) {
        const nb = new TextEncoder().encode(name.toUpperCase() + '\0');
        const np = ex.rt_malloc(nb.length);
        this.u8.set(nb, np);
        const dp = ex.rt_malloc(data.length + 16);
        this.u8.set(data, dp);
        ex.rt_add_file(np, dp, data.length);
      }
    }
    const rc = ex.rt_init();
    if (rc !== 0) throw new Error('rt_init failed: ' + rc);
    this.imageData = null;
    this.screenW = ex.rt_screen_w();
    this.screenH = ex.rt_screen_h();
  }

  setTrace(on) { this.ex.rt_set_trace(on ? 1 : 0); }
  input(type, a = 0, b = 0) { if (this.ex) this.ex.rt_input(type, a | 0, b | 0); }

  // Run the game for one slice. Returns 0 while running (see yieldKind), non-zero when it has exited.
  step() {
    this.exitCode = this.ex.rt_step(this.now());
    return this.exitCode;
  }
  get yieldKind() { return this.ex.rt_yield_kind(); }
  get framesPresented() { return this.ex.rt_frames_presented(); }

  // Copy the framebuffer through the palette into an ImageData. Returns true if the picture changed.
  render(ctx) {
    const ex = this.ex;
    if (!ex.rt_display_dirty()) return false;
    const w = ex.rt_screen_w(), h = ex.rt_screen_h(), fb = ex.rt_fb_addr(), pal = ex.rt_pal_addr();
    if (!fb) return false;
    if (!this.imageData || this.imageData.width !== w || this.imageData.height !== h) this.imageData = ctx.createImageData(w, h);
    const src = new Uint8Array(this.mem.buffer, fb, w * h);
    const lut = new Uint32Array(this.mem.buffer, pal, 256);
    const dst = new Uint32Array(this.imageData.data.buffer);
    for (let i = 0; i < dst.length; i++) dst[i] = lut[src[i]];
    ctx.putImageData(this.imageData, 0, 0);
    this.screenW = w; this.screenH = h;
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ audio
// The wasm side mixes into a planar float buffer.  While Web Audio runs, its callback pulls the mix (so the game's
// DirectSound play cursors advance with the real audio clock); otherwise (before the first user gesture, muted
// tab, ...) a timer drains the mixer at real-time speed so streaming music logic never stalls.
//
// unlock() must be called synchronously from a user gesture (iOS); attach(rt) can come later.
export class AudioOut {
  constructor() {
    this.rt = null;
    this.ctx = null;
    this.node = null;
    this.rate = 44100;
    this.muted = false;
    this.running = false;           // game loop active
    this.maxFrames = 4096;
    this.scratch = 0;
    this.lastCb = 0;
    this.lastPump = performance.now();
    this.stats = { blocks: 0, peak: 0, lastPeak: 0 };
    this.timer = setInterval(() => this.pump(), 25);
  }

  attach(rt) {
    this.rt = rt;
    this.scratch = rt.ex.rt_malloc(this.maxFrames * 2 * 4);
    rt.ex.rt_audio_init(this.rate);
  }

  _mix(frames) {
    this.rt.ex.rt_audio_render(this.scratch, frames);
    return new Float32Array(this.rt.mem.buffer, this.scratch, frames * 2);
  }

  // called from a user gesture
  unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.rate = this.ctx.sampleRate;
      if (this.rt) this.rt.ex.rt_audio_init(this.rate);
      const node = this.ctx.createScriptProcessor(2048, 0, 2);
      node.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        const n = L.length;
        this.lastCb = performance.now();
        if (!this.running || !this.rt) { L.fill(0); R.fill(0); return; }
        let peak = 0;
        for (let off = 0; off < n; off += this.maxFrames) {
          const m = Math.min(this.maxFrames, n - off);
          const mix = this._mix(m);
          for (let i = 0; i < 2 * m; i++) { const a = mix[i] < 0 ? -mix[i] : mix[i]; if (a > peak) peak = a; }
          if (this.muted) { L.fill(0, off, off + m); R.fill(0, off, off + m); }
          else { L.set(mix.subarray(0, m), off); R.set(mix.subarray(m, 2 * m), off); }
        }
        this.stats.blocks++; this.stats.lastPeak = peak; if (peak > this.stats.peak) this.stats.peak = peak;
      };
      node.connect(this.ctx.destination);
      this.node = node;
      this.ctx.resume().catch(() => {});
    } catch (err) { console.warn('audio unavailable', err); }
  }

  // fallback clock
  pump() {
    const t = performance.now();
    let dt = t - this.lastPump;
    this.lastPump = t;
    if (!this.running || !this.rt) return;
    if (this.ctx && this.ctx.state === 'running' && t - this.lastCb < 200) return;   // Web Audio is driving
    dt = Math.min(dt, 200);
    let frames = Math.floor(dt * this.rate / 1000);
    while (frames > 0) { const m = Math.min(frames, this.maxFrames); this._mix(m); frames -= m; }
  }

  setRunning(on) { this.running = on; this.lastPump = performance.now(); if (this.ctx) { if (on) this.ctx.resume().catch(() => {}); else this.ctx.suspend().catch(() => {}); } }
  setMuted(m) { this.muted = m; }
}
