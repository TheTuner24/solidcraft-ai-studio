// SolidCraft AI Studio – Tablet-Oberfläche.
// Koordinaten: Die Szene arbeitet in SolidCraft-Weltkoordinaten (mm, Z oben).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');

// ---------- 3D-Ansicht ----------
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x2a2f38);
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
camera.up.set(0, 0, 1);
camera.position.set(150, -150, 120);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const grid = new THREE.GridHelper(400, 40, 0x56606f, 0x3a414c);
grid.rotation.x = Math.PI / 2;            // Gitter in der XY-Ebene
scene.add(grid);
const axes = new THREE.AxesHelper(30);
scene.add(axes);
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

let modelRoot = null;
let firstModel = true;
const loader = new GLTFLoader();

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const dpr = Math.min(window.devicePixelRatio, 2);
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawStrokes();
}
new ResizeObserver(resize).observe(viewport);

let lastCamKey = '';
function animate() {
  controls.update();
  sun.position.copy(camera.position).add(new THREE.Vector3(50, -30, 120));
  renderer.render(scene, camera);
  const key = camera.position.toArray().map((v) => v.toFixed(2)).join() + controls.target.toArray().join();
  if (key !== lastCamKey) { lastCamKey = key; drawStrokes(); }
  requestAnimationFrame(animate);
}

function modelBox() {
  const box = new THREE.Box3();
  if (modelRoot) box.setFromObject(modelRoot);
  return box;
}

function fitView(dir) {
  const box = modelBox();
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  if (box.isEmpty()) { box.set(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 10)); }
  box.getSize(size); box.getCenter(center);
  const radius = Math.max(size.length() / 2, 10);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  const d = (dir || camera.position.clone().sub(controls.target)).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(d, dist);
  camera.near = dist / 100; camera.far = dist * 100;
  camera.updateProjectionMatrix();
  grid.position.set(Math.round(center.x / 10) * 10, Math.round(center.y / 10) * 10, 0);
}
const VIEW_TOP = new THREE.Vector3(0, -0.0001, 1);
const VIEW_ISO = new THREE.Vector3(1, -1, 0.8);

let wantedRev = 0;
function loadModel(rev, empty) {
  wantedRev = rev;
  if (empty) { setModel(null); return; }
  loader.load(`/model.glb?rev=${rev}`, (gltf) => {
    // Bei schnellen Änderungen kann ein älterer Download später fertig werden: verwerfen.
    if (rev !== wantedRev) return;
    const root = gltf.scene;
    // SolidCraft exportiert in Metern mit Y oben (Wurzelknoten gedreht und skaliert):
    // die Wurzeltransformation zurücksetzen ergibt wieder mm mit Z oben.
    for (const child of root.children) { child.quaternion.identity(); child.scale.set(1, 1, 1); child.position.set(0, 0, 0); }
    root.traverse((o) => {
      if (o.isMesh) {
        o.material.side = THREE.DoubleSide;
        o.material.polygonOffset = true; o.material.polygonOffsetFactor = 1; o.material.polygonOffsetUnits = 1;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 25),
          new THREE.LineBasicMaterial({ color: 0x111418 }));
        edges.userData.isEdge = true;
        o.add(edges);
      }
    });
    setModel(root);
  }, undefined, (err) => toast('Modell konnte nicht geladen werden: ' + err.message));
}

function setModel(root) {
  if (modelRoot) {
    scene.remove(modelRoot);
    modelRoot.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
  }
  modelRoot = root;
  if (root) scene.add(root);
  if (root && firstModel) { firstModel = false; fitView(VIEW_ISO.clone()); }
  reanchorStrokes();
}

// Kamera im Format von SolidCraft (ui.camera / view.apply): yaw 0 = Blick entlang +Y.
function scCamera() {
  const dir = controls.target.clone().sub(camera.position);
  const distance = dir.length();
  dir.normalize();
  return {
    target: controls.target.toArray().map((v) => +v.toFixed(3)),
    yaw: +Math.atan2(dir.x, dir.y).toFixed(5),
    pitch: +Math.asin(-dir.z).toFixed(5),
    distance: +distance.toFixed(2),
    fov_deg: camera.fov,
  };
}

// ---------- Stiftstriche ----------
// Jeder Punkt eines Strichs bekommt einen 3D-Anker (Treffer am Modell, sonst Bodenebene Z=0,
// sonst Ebene durch das Blickziel), so bleiben Striche beim Drehen am Modell kleben.
let tool = 'pen';
// Strichfarben: nur Unterscheidung, keine feste Bedeutung. Was eine Farbe meint, sagt der Benutzer.
const COLORS = [
  { name: 'rot', hex: '#ff3b3b' }, { name: 'blau', hex: '#2f8cff' }, { name: 'grün', hex: '#2ecc55' },
  { name: 'orange', hex: '#ff9a1f' }, { name: 'violett', hex: '#b45cff' }, { name: 'türkis', hex: '#19d3c5' },
];
let color = COLORS[0];
let legend = {};
let strokes = [];
let current = null;
let lastPen = 0;
const raycaster = new THREE.Raycaster();

function ndc(x, y) {
  return new THREE.Vector2((x / viewport.clientWidth) * 2 - 1, -(y / viewport.clientHeight) * 2 + 1);
}

function pick(x, y) {
  raycaster.setFromCamera(ndc(x, y), camera);
  if (modelRoot) {
    const meshes = [];
    modelRoot.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit) {
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      if (n && n.dot(raycaster.ray.direction) > 0) n.negate();
      let body = hit.object.name;
      for (let o = hit.object; o && o !== modelRoot; o = o.parent) if (o.name) { body = o.name; break; }
      return { p: hit.point.clone(), n, body, on: 'modell' };
    }
  }
  const g = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, g) && g.distanceTo(camera.position) < camera.far) {
    return { p: g, n: new THREE.Vector3(0, 0, 1), body: null, on: 'boden' };
  }
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    camera.getWorldDirection(new THREE.Vector3()), controls.target);
  const v = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, v);
  return { p: v, n: null, body: null, on: 'ansicht' };
}

function project(p) {
  const v = p.clone().project(camera);
  return [(v.x + 1) / 2 * viewport.clientWidth, (1 - v.y) / 2 * viewport.clientHeight, v.z];
}

function reanchorStrokes() {
  // Die 3D-Anker bleiben gültig, solange sich die markierte Stelle nicht ändert.
  drawStrokes();
}

function drawStrokes() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  for (const s of [...strokes, current].filter(Boolean)) {
    const pts = s.anchors && s.cam !== lastCamKeyAtDraw() ? s.anchors.map((a) => project(a.p)) : s.pts;
    if (pts.length < 1) continue;
    const hex = (s.color || COLORS[0]).hex;
    octx.strokeStyle = hex;
    octx.globalAlpha = s === current ? 0.8 : 1;
    octx.lineCap = 'round'; octx.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      const pr = s.pr[i] ?? 0.5;
      octx.lineWidth = 1.5 + pr * 4;
      octx.beginPath(); octx.moveTo(pts[i - 1][0], pts[i - 1][1]); octx.lineTo(pts[i][0], pts[i][1]); octx.stroke();
    }
    if (pts.length === 1) { octx.fillStyle = hex; octx.beginPath(); octx.arc(pts[0][0], pts[0][1], 3, 0, 7); octx.fill(); }
  }
  octx.globalAlpha = 1;
  updateMarkInfo();
}
function lastCamKeyAtDraw() { return lastCamKey; }

function finishStroke(s) {
  if (s.pts.length < 2) s.pts.push([s.pts[0][0] + 0.5, s.pts[0][1] + 0.5]);
  s.anchors = s.pts.map(([x, y]) => pick(x, y));
  s.cam = lastCamKey;
  const [x0, y0] = s.pts[0], [x1, y1] = s.pts[s.pts.length - 1];
  const len = s.pts.reduce((acc, p, i) => i ? acc + Math.hypot(p[0] - s.pts[i - 1][0], p[1] - s.pts[i - 1][1]) : 0, 0);
  s.closed = len > 60 && Math.hypot(x1 - x0, y1 - y0) < Math.max(30, len * 0.15);
  s.inside = s.closed ? interiorHits(s.pts) : [];
  strokes.push(s);
}

function interiorHits(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const x = minX + (maxX - minX) * i / steps, y = minY + (maxY - minY) * j / steps;
    if (pointInPoly(x, y, pts)) out.push(pick(x, y));
  }
  return out;
}
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function eraseAt(x, y) {
  const before = strokes.length;
  strokes = strokes.filter((s) => {
    const pts = s.anchors ? s.anchors.map((a) => project(a.p)) : s.pts;
    return !pts.some((p) => Math.hypot(p[0] - x, p[1] - y) < 18);
  });
  if (strokes.length !== before) drawStrokes();
}

function local(e) {
  const r = viewport.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
const isEraserButton = (e) => (e.buttons & 32) || (e.buttons & 2) || tool === 'eraser';

// Stift (und linke Maustaste) zeichnet; Finger drehen das Modell. Handballen werden
// ignoriert, solange der Stift aktiv ist.
viewport.addEventListener('pointerdown', (e) => {
  const draws = e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0);
  if (e.pointerType === 'touch' && performance.now() - lastPen < 600) { e.stopPropagation(); return; }
  if (!draws) return;
  e.stopPropagation(); e.preventDefault();
  if (e.pointerType === 'pen') lastPen = performance.now();
  viewport.setPointerCapture(e.pointerId);
  const [x, y] = local(e);
  if (isEraserButton(e)) { current = { erase: true, id: e.pointerId }; eraseAt(x, y); return; }
  current = { id: e.pointerId, pts: [[x, y]], pr: [e.pressure || 0.5], color };
  drawStrokes();
}, true);
viewport.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'pen') lastPen = performance.now();
  if (e.pointerType === 'touch' && performance.now() - lastPen < 600) { e.stopPropagation(); return; }
  if (!current || current.id !== e.pointerId) return;
  e.stopPropagation();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of events) {
    const [x, y] = local(ce);
    if (current.erase) { eraseAt(x, y); continue; }
    const last = current.pts[current.pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < 2) continue;
    current.pts.push([x, y]); current.pr.push(ce.pressure || 0.5);
  }
  drawStrokes();
}, true);
const endStroke = (e) => {
  if (!current || current.id !== e.pointerId) return;
  e.stopPropagation();
  if (!current.erase) finishStroke(current);
  current = null;
  drawStrokes();
};
viewport.addEventListener('pointerup', endStroke, true);
viewport.addEventListener('pointercancel', endStroke, true);

function updateMarkInfo() {
  const n = strokes.length;
  const onModel = strokes.filter((s) => s.anchors?.some((a) => a.on === 'modell')).length;
  const byColor = {};
  for (const s of strokes) byColor[s.color.name] = (byColor[s.color.name] || 0) + 1;
  const colors = Object.keys(byColor).length > 1 ? ' (' + Object.entries(byColor).map(([c, k]) => `${k}× ${c}`).join(', ') + ')' : '';
  $('#markinfo').textContent = n ? `${n} Strich${n > 1 ? 'e' : ''}${colors}${onModel ? `, ${onModel} auf dem Modell` : ''}` : '';
}

const r3 = (v) => v ? v.toArray().map((c) => +c.toFixed(2)) : null;
function marksPayload() {
  return strokes.map((s, i) => {
    const step = Math.max(1, Math.floor(s.anchors.length / 24));
    const hits = s.anchors.filter((_, k) => k % step === 0);
    const fmt = (a) => ({ p: r3(a.p), n: a.n ? r3(a.n) : undefined, body: a.body || undefined, auf: a.on });
    return {
      strich: i + 1,
      farbe: s.color.name,
      art: s.closed ? 'geschlossen (eingekreist)' : 'offen',
      punkte_entlang: hits.map(fmt),
      punkte_innen: s.inside.filter((a) => a.on === 'modell').map(fmt),
      bildschirm_box: bbox2d(s.pts),
    };
  });
}
function bbox2d(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
}

function snapshot() {
  // Ansicht plus Striche als ein Bild (lange Seite höchstens 1568 px).
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const scale = Math.min(1, 1568 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  renderer.render(scene, camera);
  ctx.drawImage(renderer.domElement, 0, 0, c.width, c.height);
  ctx.drawImage(overlay, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

// ---------- Verbindung ----------
let ws = null;
let busy = false;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => $('#conn').classList.add('on');
  ws.onclose = () => { $('#conn').classList.remove('on'); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}
const send = (msg) => ws?.readyState === 1 ? ws.send(JSON.stringify(msg)) : toast('Keine Verbindung zum PC');

let lastModelRev = -1;
let pendingLocalUser = false;
let agentBlock = null;
function handle(m) {
  switch (m.type) {
    case 'hello':
      $('#log').innerHTML = '';
      for (const l of m.log) handle(l);
      setBusy(m.busy);
      break;
    case 'model':
      if (m.rev !== lastModelRev) { lastModelRev = m.rev; loadModel(m.rev, m.empty); }
      $('#docname').textContent = (m.project ? m.project.split('/').pop() : m.name || '–') + (m.dirty ? ' •' : '');
      $('#undo').disabled = !m.undo; $('#redo').disabled = !m.redo;
      break;
    case 'agent':
      if (m.kind === 'user' && pendingLocalUser) { pendingLocalUser = false; break; }
      agentMsg(m); break;
    case 'busy': setBusy(m.busy); break;
    case 'status': if (m.solidcraft === false) toast('SolidCraft nicht erreichbar: ' + m.text); break;
    case 'saved': toast('Gespeichert: ' + m.path); break;
    case 'error': toast(m.text); break;
    case 'reset': $('#log').innerHTML = ''; firstModel = true; strokes = []; drawStrokes(); break;
    case 'files': showFiles(m.files); break;
    case 'legend': legend = m.legend || {}; renderPalette(); break;
    case 'backend': {
      const b = $('#backend'), local = m.mode === 'lokal';
      b.classList.toggle('lokal', local);
      b.innerHTML = local ? '⌂<span>Lokal</span>' : '☁<span>Online</span>';
      b.title = local ? `KI lokal: ${m.local_model} über Ollama. Antippen für Online (Claude).`
                      : 'KI online: Claude. Antippen für Lokal (Ollama).';
      break;
    }
  }
}

function agentMsg(m) {
  const log = $('#log');
  const div = document.createElement('div');
  if (m.kind === 'user') {
    div.className = 'msg user';
    div.textContent = (m.text || '(Skizze)') + (m.marks ? `\n✎ ${m.marks} Strich${m.marks > 1 ? 'e' : ''}` : '');
    if (m.image) { const img = new Image(); img.src = m.image; div.append(img); }
    agentBlock = null;
  } else if (m.kind === 'text') {
    div.className = 'msg agent'; div.textContent = m.text; agentBlock = null;
  } else if (m.kind === 'tool') {
    if (!agentBlock) { agentBlock = document.createElement('div'); agentBlock.className = 'tools'; log.append(agentBlock); }
    const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = m.name;
    agentBlock.append(chip); log.scrollTop = log.scrollHeight; return;
  } else if (m.kind === 'done') {
    agentBlock = null;
    if (m.ok) { div.className = 'msg done'; div.textContent = `fertig${m.ms ? ` · ${(m.ms / 1000).toFixed(0)} s` : ''}`; }
    else { div.className = 'msg error'; div.textContent = 'Fehler: ' + (m.error || 'unbekannt'); }
  } else if (m.kind === 'error') {
    div.className = 'msg error'; div.textContent = m.text;
  } else return;
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

function setBusy(b) {
  busy = b;
  $('#busy').hidden = !b;
  $('#send').disabled = b;
  for (const id of ['#revert', '#new', '#open', '#save', '#backend']) $(id).disabled = b;
  if (b) { $('#undo').disabled = true; $('#redo').disabled = true; }
}

// ---------- Bedienung ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const text = $('#text').value.trim();
  if (!text && !strokes.length) { toast('Schreib, was passieren soll, oder zeichne etwas.'); return; }
  for (const s of strokes) if (!s.anchors) { s.anchors = s.pts.map(([x, y]) => pick(x, y)); s.inside = s.closed ? interiorHits(s.pts) : []; }
  const image = snapshot();
  send({ type: 'prompt', text, image, marks: marksPayload(), camera: scCamera(),
         view: { width: viewport.clientWidth, height: viewport.clientHeight } });
  agentMsg({ kind: 'user', text, marks: strokes.length, image: strokes.length ? image : null });
  pendingLocalUser = true;
  $('#text').value = '';
  strokes = []; drawStrokes();
});
// ---------- Sprache: antippen, sprechen, antippen; der Text landet im Eingabefeld ----------
let recorder = null;
async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) { toast('Kein Mikrofon-Zugriff: ' + e.message); return; }
  const type = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    $('#mic').classList.remove('rec'); $('#mic').classList.add('wait');
    try {
      const r = await fetch('/stt', { method: 'POST', body: new Blob(chunks, { type: recorder.mimeType }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (j.text) {
        const t = $('#text');
        t.value = (t.value.trim() ? t.value.trim() + ' ' : '') + j.text;
        t.focus(); t.setSelectionRange(t.value.length, t.value.length);
      } else toast('Nichts verstanden.');
    } catch (e) { toast('Spracherkennung: ' + e.message); }
    $('#mic').classList.remove('wait');
    recorder = null;
  };
  recorder.start();
  $('#mic').classList.add('rec');
}
$('#mic').addEventListener('click', () => {
  if ($('#mic').classList.contains('wait')) return;
  if (recorder && recorder.state === 'recording') recorder.stop(); else startRecording();
});

$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});

function renderPalette() {
  const pal = $('#palette');
  pal.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.dataset.color = c.name;
    b.className = c === color ? 'active' : '';
    const meaning = legend[c.name];
    b.title = meaning ? `${c.name}: ${meaning}` : `${c.name} (Bedeutung sagst du der KI, z. B. „${c.name} ist …“)`;
    b.innerHTML = `<i class="swatch" style="background:${c.hex}"></i><span>${meaning || c.name}</span>`;
    b.onclick = () => {
      color = c;
      if (tool === 'eraser') document.querySelector('[data-tool="pen"]').click();
      renderPalette();
    };
    pal.append(b);
  }
}
renderPalette();

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  tool = b.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
}));
$('#clear').onclick = () => { strokes = []; drawStrokes(); };
$('#undo').onclick = () => send({ type: 'undo' });
$('#redo').onclick = () => send({ type: 'redo' });
$('#revert').onclick = () => { if (confirm('Letzte KI-Runde komplett zurücknehmen?')) send({ type: 'revert_turn' }); };
$('#fit').onclick = () => fitView();
$('#top').onclick = () => fitView(VIEW_TOP.clone());
$('#iso').onclick = () => fitView(VIEW_ISO.clone());
$('#topc').onclick = () => { send({ type: 'camera', camera: scCamera() }); toast('Ansicht an PC übergeben'); };
$('#new').onclick = () => {
  const name = prompt('Name des neuen Bauteils:', 'Neues Bauteil');
  if (name !== null) send({ type: 'new', name });
};
$('#open').onclick = () => send({ type: 'list' });
$('#backend').onclick = () => {
  const local = $('#backend').classList.contains('lokal');
  if (confirm(local ? 'Auf Online (Claude) umschalten? Das Gespräch mit dem Agenten beginnt neu.'
                    : 'Auf Lokal (Ollama) umschalten? Das Gespräch mit dem Agenten beginnt neu.'))
    send({ type: 'backend', mode: local ? 'online' : 'lokal' });
};
$('#save').onclick = () => send({ type: 'save' });
$('#stop').onclick = () => send({ type: 'stop' });
$('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();

function showFiles(files) {
  const ul = $('#files'); ul.innerHTML = '';
  if (!files.length) ul.innerHTML = '<li class="note">Keine .sc-Dateien in ~/CAD gefunden.</li>';
  for (const f of files) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${f.name}<small>${f.studio ? 'Studio' : 'Original → Kopie'} · ${new Date(f.mtime * 1000).toLocaleString('de-DE')}</small>`;
    b.onclick = () => { send({ type: 'open', path: f.path }); $('#filedlg').close(); };
    li.append(b); ul.append(li);
  }
  $('#filedlg').showModal();
}

let toastTimer;
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// Für automatische Tests: Weltpunkt (mm) → Bildschirmpunkt in der Ansicht.
window.studioDebug = { worldToScreen: (x, y, z) => project(new THREE.Vector3(x, y, z)), state: () => ({ strokes: strokes.length, current: !!current, tool, color: color.name, legend,
    strokeColors: strokes.map((s) => s.color.name), pressures: strokes.map((s) => s.pr) }),
  marks: () => marksPayload(),
  overlayPixels: () => {
    const d = octx.getImageData(0, 0, overlay.width, overlay.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  },
  // Anteil der Pixel im übertragenen Bild, die der Farbe nahekommen (Prüfung „Farbe im Bild“).
  imageHasColor: async (hex) => {
    const img = new Image(); img.src = snapshot(); await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 60) n++;
    return n;
  },
};

if (location.search.includes('t=')) history.replaceState(null, '', '/');
fitView(VIEW_ISO.clone());
resize();
animate();
connect();
