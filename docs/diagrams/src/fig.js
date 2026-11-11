// Diagram helper library: boxes are HTML placed by CENTER coordinates (so straight
// connectors line up), wires are SVG. Labels are placed BESIDE a line, never on it.
const NS = 'http://www.w3.org/2000/svg';
const FIG = document.getElementById('fig');
let SVG, DEFS;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function initSvg() {
  SVG = el('svg', { class: 'wires', width: FIG.offsetWidth, height: FIG.offsetHeight });
  DEFS = el('defs', {}, SVG);
  FIG.appendChild(SVG);
}
function R(id) {
  const e = typeof id === 'string' ? document.getElementById(id) : id;
  if (!e) throw new Error('missing #' + id);
  const r = e.getBoundingClientRect(), c = FIG.getBoundingClientRect();
  return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
}
function P(id, side, off = 0) {
  const r = R(id);
  switch (side) {
    case 'l': return [r.x, r.y + r.h / 2 + off];
    case 'r': return [r.x + r.w, r.y + r.h / 2 + off];
    case 't': return [r.x + r.w / 2 + off, r.y];
    case 'b': return [r.x + r.w / 2 + off, r.y + r.h];
    default: return [r.x + r.w / 2, r.y + r.h / 2];
  }
}
// ---- node builders (center-based) ---------------------------------------
function B(id, cx, cy, w, cls, html, opt = {}) {
  const d = document.createElement('div');
  d.id = id; d.className = 'box ' + (cls || ''); d.style.width = w + 'px';
  if (opt.h) d.style.height = opt.h + 'px';
  d.innerHTML = html; FIG.appendChild(d);
  const hh = d.offsetHeight;
  d.style.left = (cx - w / 2) + 'px'; d.style.top = (cy - hh / 2) + 'px';
  return d;
}
function D(id, cx, cy, w, h, html, fill = '#fff8e1', stroke = '#b8860b') {
  const d = document.createElement('div');
  d.id = id; d.className = 'dmd'; d.dataset.fill = fill; d.dataset.stroke = stroke;
  Object.assign(d.style, { left: (cx - w / 2) + 'px', top: (cy - h / 2) + 'px', width: w + 'px', height: h + 'px' });
  d.innerHTML = html; FIG.appendChild(d); return d;
}
function C(id, x, y, w, h, title, color, titleX = 14) {
  const d = document.createElement('div');
  d.id = id; d.className = 'cont';
  Object.assign(d.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', borderColor: color });
  d.innerHTML = `<div class="lab" style="color:${color};left:${titleX}px">${title}</div>`;
  FIG.appendChild(d); return d;
}
function T(x, y, html, cls = 'note', w) {
  const d = document.createElement('div'); d.className = cls; d.innerHTML = html;
  d.style.left = x + 'px'; d.style.top = y + 'px'; if (w) d.style.width = w + 'px';
  FIG.appendChild(d); return d;
}
// ---- wires ---------------------------------------------------------------
function marker(color) {
  const id = 'm' + color.replace(/[^a-z0-9]/gi, '');
  if (!document.getElementById(id)) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 6.5, markerHeight: 6.5, orient: 'auto-start-reverse' }, DEFS);
    el('path', { d: 'M0,0.6 L10,5 L0,9.4 z', fill: color }, m);
  }
  return id;
}
function roundPath(pts, r = 8) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
    if (d1 < 0.5 || d2 < 0.5) { d += ` L${x1},${y1}`; continue; }
    const rr = Math.min(r, d1 / 2, d2 / 2);
    d += ` L${x1 - (x1 - x0) / d1 * rr},${y1 - (y1 - y0) / d1 * rr} Q${x1},${y1} ${x1 + (x2 - x1) / d2 * rr},${y1 + (y2 - y1) / d2 * rr}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]},${l[1]}`;
}
// Label beside a segment: horizontal -> above (or below), vertical -> right (or left).
function wireLabel(text, p0, p1, t, side, color) {
  const horiz = Math.abs(p1[1] - p0[1]) < Math.abs(p1[0] - p0[0]);
  const x = p0[0] + (p1[0] - p0[0]) * t, y = p0[1] + (p1[1] - p0[1]) * t;
  const d = document.createElement('div'); d.className = 'lbl'; d.innerHTML = text;
  if (color) d.style.color = color;
  let tf;
  if (horiz) {
    if (side === 'below') { d.style.left = x + 'px'; d.style.top = (y + 5) + 'px'; tf = 'translate(-50%,0)'; }
    else { d.style.left = x + 'px'; d.style.top = (y - 5) + 'px'; tf = 'translate(-50%,-100%)'; }
  } else {
    if (side === 'left') { d.style.left = (x - 7) + 'px'; d.style.top = y + 'px'; tf = 'translate(-100%,-50%)'; d.style.textAlign = 'right'; }
    else { d.style.left = (x + 7) + 'px'; d.style.top = y + 'px'; tf = 'translate(0,-50%)'; }
  }
  d.style.transform = tf; FIG.appendChild(d); return d;
}
// link(a, aSide, b, bSide, o): a/b = id or [x,y]
// o: route 'straight'|'hv'|'vh'|'hvh'|'vhv', mx/my, via:[[x|null,y|null]..], ao/bo offsets,
//    color, w, dash, both, label, lseg (segment index, default longest), lt (0..1), lside
function link(a, as, b, bs, o = {}) {
  const p1 = Array.isArray(a) ? a : P(a, as, o.ao || 0);
  const p2 = Array.isArray(b) ? b : P(b, bs, o.bo || 0);
  const pts = [p1];
  const route = o.route || 'straight';
  if (o.via) { let prev = p1; for (const v of o.via) { const q = [v[0] ?? prev[0], v[1] ?? prev[1]]; pts.push(q); prev = q; } }
  else if (route === 'hv') pts.push([p2[0], p1[1]]);
  else if (route === 'vh') pts.push([p1[0], p2[1]]);
  else if (route === 'hvh') { const mx = o.mx ?? (p1[0] + p2[0]) / 2; pts.push([mx, p1[1]], [mx, p2[1]]); }
  else if (route === 'vhv') { const my = o.my ?? (p1[1] + p2[1]) / 2; pts.push([p1[0], my], [p2[0], my]); }
  pts.push(p2);
  const color = o.color || '#6b7280';
  const path = el('path', { d: roundPath(pts), fill: 'none', stroke: color, 'stroke-width': o.w || 1.7, 'stroke-linejoin': 'round', 'stroke-linecap': 'butt' }, SVG);
  if (o.dash) path.setAttribute('stroke-dasharray', o.dash === true ? '6 4' : o.dash);
  if (!o.noArrow) path.setAttribute('marker-end', `url(#${marker(color)})`);
  if (o.both) path.setAttribute('marker-start', `url(#${marker(color)})`);
  if (o.label) {
    let s = o.lseg;
    if (s === undefined) { let best = -1; for (let i = 0; i < pts.length - 1; i++) { const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if (L > best) { best = L; s = i; } } }
    wireLabel(o.label, pts[s], pts[s + 1], o.lt ?? 0.5, o.lside, o.lcolor);
  }
  return pts;
}
function diamonds() {
  document.querySelectorAll('.dmd').forEach(d => {
    const r = R(d);
    el('polygon', { points: `${r.x + r.w / 2},${r.y} ${r.x + r.w},${r.y + r.h / 2} ${r.x + r.w / 2},${r.y + r.h} ${r.x},${r.y + r.h / 2}`, fill: d.dataset.fill, stroke: d.dataset.stroke, 'stroke-width': 1.6 }, SVG);
  });
}
function done() { window.__done = true; }
