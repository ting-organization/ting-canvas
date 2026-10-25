// The canvas on screen: the week's pixels with the draft on top, zoom and pan,
// and painting with a mouse, pen or finger.

export const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

/** The pixels as an image, one canvas pixel per pixel. */
export function imageOf(config, colors, target = document.createElement('canvas')) {
  target.width = config.width;
  target.height = config.height;
  const ctx = target.getContext('2d');
  const image = ctx.createImageData(config.width, config.height);
  for (let i = 0; i < colors.length; i++) {
    const rgb = config.palette[colors[i]] ?? [255, 255, 255];
    image.data[i * 4] = rgb[0];
    image.data[i * 4 + 1] = rgb[1];
    image.data[i * 4 + 2] = rgb[2];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return target;
}

export class Painter {
  /**
   * `options`: `editable`, `maxDraft`, and callbacks `onDraft()` after the
   * draft changes, `onHover(index | null)`, `onPick(color)` and `onLimit()`.
   */
  constructor(host, config, options = {}) {
    this.host = host;
    this.config = config;
    this.options = options;
    this.colors = new Uint8Array(config.width * config.height);
    this.marks = new Uint8Array(config.width * config.height);
    this.draft = new Map();
    // The darkest color to start with: it shows on the white of a fresh canvas.
    const light = (rgb) => Math.max(...rgb);
    this.color = config.palette.reduce((best, rgb, i) => (light(rgb) < light(config.palette[best]) ? i : best), 0);
    this.tool = 'brush';
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.hover = null;
    this.pointers = new Map();
    this.gesture = null;
    /** Until someone zooms or moves it, the canvas keeps fitting its stage. */
    this.moved = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'painter';
    this.canvas.setAttribute('aria-label', `Canvas of ${config.width} by ${config.height} pixels`);
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.base = imageOf(config, this.colors);

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    const on = (type, fn, opts) => this.canvas.addEventListener(type, fn, opts);
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.up(e));
    on('pointercancel', (e) => this.up(e));
    on('pointerleave', () => this.setHover(null));
    on('wheel', (e) => this.wheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    this.resize();
  }

  destroy() {
    this.resizer.disconnect();
    this.canvas.remove();
  }

  setPixels(colors, marks) {
    this.colors = colors;
    this.marks = marks;
    imageOf(this.config, colors, this.base);
    this.render();
  }

  clearDraft() {
    this.draft.clear();
    this.render();
    this.options.onDraft?.();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    if (!this.moved) this.fit();
    this.render();
  }

  fit() {
    this.moved = false;
    const { width, height } = this.config;
    const s = Math.min((this.width - 32) / width, (this.height - 32) / height);
    this.scale = s >= 1 ? Math.floor(s) : Math.max(s, 0.25);
    this.ox = Math.round((this.width - width * this.scale) / 2);
    this.oy = Math.round((this.height - height * this.scale) / 2);
    this.render();
  }

  zoomAt(factor, cx = this.width / 2, cy = this.height / 2) {
    this.moved = true;
    const next = Math.min(64, Math.max(0.25, this.scale * factor));
    this.ox = cx - ((cx - this.ox) * next) / this.scale;
    this.oy = cy - ((cy - this.oy) * next) / this.scale;
    this.scale = next;
    this.render();
  }

  /** The pixel under a point of the canvas element, or null. */
  cellAt(px, py) {
    const x = Math.floor((px - this.ox) / this.scale);
    const y = Math.floor((py - this.oy) / this.scale);
    if (x < 0 || y < 0 || x >= this.config.width || y >= this.config.height) return null;
    return { x, y, index: y * this.config.width + x };
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const [px, py] = this.point(e);
    this.pointers.set(e.pointerId, [px, py]);
    if (this.pointers.size === 2) {
      // A second finger turns the gesture into a pinch.
      const [a, b] = [...this.pointers.values()];
      this.gesture = { mode: 'pinch', distance: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
    let mode = this.tool;
    if (e.button === 1 || this.spaceHeld || !this.options.editable) mode = 'pan';
    if (e.button === 2) mode = 'erase';
    this.gesture = { mode, last: null, start: [px, py], origin: [this.ox, this.oy] };
    if (mode === 'pick') {
      const cell = this.cellAt(px, py);
      if (cell) this.options.onPick?.(this.draft.get(cell.index) ?? this.colors[cell.index]);
      this.gesture = null;
    } else if (mode === 'brush' || mode === 'erase') {
      this.stroke(px, py);
    }
  }

  move(e) {
    const [px, py] = this.point(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, [px, py]);
    const g = this.gesture;
    if (g?.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.ox += mid[0] - g.mid[0];
      this.oy += mid[1] - g.mid[1];
      if (g.distance > 0) this.zoomAt(distance / g.distance, mid[0], mid[1]);
      g.distance = distance;
      g.mid = mid;
      return;
    }
    if (g?.mode === 'pan') {
      this.moved = true;
      this.ox = g.origin[0] + px - g.start[0];
      this.oy = g.origin[1] + py - g.start[1];
      this.render();
    } else if (g?.mode === 'brush' || g?.mode === 'erase') {
      this.stroke(px, py);
    }
    const cell = this.cellAt(px, py);
    this.setHover(cell ? cell.index : null);
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.gesture = null;
  }

  wheel(e) {
    e.preventDefault();
    const [px, py] = this.point(e);
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), px, py);
    } else {
      this.moved = true;
      this.ox -= e.deltaX;
      this.render();
    }
  }

  setHover(index) {
    if (index === this.hover) return;
    this.hover = index;
    this.options.onHover?.(index);
    this.render();
  }

  /** Paints or erases every pixel on the line from the last point to this one. */
  stroke(px, py) {
    const cell = this.cellAt(px, py);
    const g = this.gesture;
    const from = g.last ?? cell;
    if (!cell || !from) {
      g.last = cell;
      return;
    }
    let { x: x0, y: y0 } = from;
    const { x: x1, y: y1 } = cell;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let changed = false;
    for (;;) {
      changed = this.apply(y0 * this.config.width + x0, g.mode) || changed;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    g.last = cell;
    if (changed) {
      this.render();
      this.options.onDraft?.();
    }
  }

  apply(index, mode) {
    if (mode === 'erase') return this.draft.delete(index);
    if (this.draft.get(index) === this.color) return false;
    if (!this.draft.has(index) && this.draft.size >= (this.options.maxDraft ?? Infinity)) {
      this.options.onLimit?.();
      return false;
    }
    this.draft.set(index, this.color);
    return true;
  }

  render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const { ctx, scale: s, ox, oy } = this;
    const { width, height, palette } = this.config;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(ox + 2, oy + 3, width * s, height * s);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, ox, oy, width * s, height * s);

    for (const [index, color] of this.draft) {
      const x = index % width, y = Math.floor(index / width);
      ctx.fillStyle = css(palette[color]);
      ctx.fillRect(ox + x * s, oy + y * s, s, s);
    }
    if (s >= 6 && this.draft.size) {
      // Draft pixels carry a corner mark, so they read as not yet painted.
      const m = Math.max(2, Math.round(s / 4));
      for (const [index, color] of this.draft) {
        const x = index % width, y = Math.floor(index / width);
        const [r, g, b] = palette[color];
        ctx.fillStyle = r * 0.3 + g * 0.59 + b * 0.11 > 140 ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.8)';
        ctx.fillRect(ox + x * s, oy + y * s, m, m);
      }
    }
    if (s >= 10) {
      ctx.strokeStyle = 'rgba(0,0,0,.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.max(0, Math.floor(-ox / s)), x1 = Math.min(width, Math.ceil((this.width - ox) / s));
      const y0 = Math.max(0, Math.floor(-oy / s)), y1 = Math.min(height, Math.ceil((this.height - oy) / s));
      for (let x = x0; x <= x1; x++) {
        ctx.moveTo(Math.round(ox + x * s) + 0.5, oy + y0 * s);
        ctx.lineTo(Math.round(ox + x * s) + 0.5, oy + y1 * s);
      }
      for (let y = y0; y <= y1; y++) {
        ctx.moveTo(ox + x0 * s, Math.round(oy + y * s) + 0.5);
        ctx.lineTo(ox + x1 * s, Math.round(oy + y * s) + 0.5);
      }
      ctx.stroke();
    }
    if (this.hover != null && this.options.editable) {
      const x = this.hover % width, y = Math.floor(this.hover / width);
      if (this.tool === 'brush' && !this.gesture) {
        ctx.fillStyle = css(palette[this.color]);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(ox + x * s, oy + y * s, s, s);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + x * s - 0.5, oy + y * s - 0.5, s + 1, s + 1);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.strokeRect(ox + x * s - 1.5, oy + y * s - 1.5, s + 3, s + 3);
    }
  }
}
