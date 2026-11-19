// Reproduzierbarer Funktionstest für SolidCraft AI Studio.
//
//   --smoke  ohne KI: Oberfläche lädt, Verbindung steht, Stiftstrich wird erkannt und
//            auf dem Modell verankert, Radieren/Löschen geht. Ändert das Design nicht.
//   --full   mit KI (verbraucht Claude-Kontingent, ca. 1 min): neues Bauteil aus Skizze + Text,
//            Kante einkreisen und runden, speichern. Prüft das Ergebnis über den Steuerkanal
//            (Volumen) statt nur über die Antwort der KI.
//
// Voraussetzung: Studio läuft (./start.sh). Browser: Chrome/Chromium, Pfad über CHROME=…
// Ergebnisbilder landen in ./ergebnis/.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE = process.argv.includes('--full') ? 'full' : 'smoke';
const CACHE = path.join(os.homedir(), 'CAD/ai-studio/.cache');
const URL = process.env.STUDIO_URL || fs.readFileSync(path.join(CACHE, 'studio-url.txt'), 'utf8').trim();
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 7979);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'ergebnis');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));

let failed = 0;
const ok = (cond, text) => { console.log(`${cond ? 'OK  ' : 'FEHL'} ${text}`); if (!cond) failed++; };

// Steuerkanal von SolidCraft: eine JSON-Zeile pro Anfrage, erste mit Token.
async function control(method, params = {}) {
  const tokenFile = path.join(os.homedir(), `.local/share/solidcraft/control/${CONTROL_PORT}.token`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const s = net.createConnection(CONTROL_PORT, '127.0.0.1');
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) { s.end(); const r = JSON.parse(buf.split('\n')[0]); r.ok ? resolve(r.result) : reject(new Error(r.error)); }
    });
    s.on('error', reject);
    s.write(JSON.stringify({ id: 1, method, params, token }) + '\n');
  });
}
async function volume() {
  const doc = await control('document.inspect', { measure: true, timeline: false });
  return (doc.bodies || []).reduce((v, b) => v + (b.volume_mm3 ?? b.measure?.volume_mm3 ?? 0), 0);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.SICHTBAR,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(HERE, 'testdaten/durchmesser.wav')}`] });
const context = await browser.newContext({ viewport: { width: 1400, height: 875 }, hasTouch: true, permissions: ['microphone'] });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
// Echte (vertrauenswürdige) Stift- und Fingerereignisse über das DevTools-Protokoll:
// Stift = Mausereignis mit pointerType "pen" und Druck (force), Finger = Touch mit Kontaktradius.
const pen = async (pts, { buttons = 1, button = 'left' } = {}) => {
  const ev = (type, [x, y, force], extra = {}) => cdp.send('Input.dispatchMouseEvent',
    { type, x, y, pointerType: 'pen', force, button, buttons, clickCount: 1, ...extra });
  await ev('mouseMoved', pts[0], { buttons: 0, button: 'none' });            // Schweben
  await ev('mousePressed', pts[0]);
  for (const q of pts.slice(1)) await ev('mouseMoved', q);
  await ev('mouseReleased', pts.at(-1), { buttons: 0 });
};
const touch = async (pts, radius = 6) => {
  const tp = ([x, y]) => [{ x, y, radiusX: radius, radiusY: radius, force: 1, id: 7 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) });
  for (const q of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(q) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const line = (x0, y0, x1, y1, n = 12, f0 = 0.5, f1 = 0.5) =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, f0 + (f1 - f0) * i / n]);
page.on('pageerror', (e) => ok(false, 'Seitenfehler: ' + e.message));
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Funktionstest') : d.accept()));
const state = () => page.evaluate(() => window.studioDebug.state());
const vp = async () => page.locator('#viewport').boundingBox();
const toScreen = async (x, y, z) => {
  const box = await vp();
  const [sx, sy] = await page.evaluate(([x, y, z]) => window.studioDebug.worldToScreen(x, y, z), [x, y, z]);
  return [box.x + sx, box.y + sy];
};
const stroke = async (pts) => {
  await page.mouse.move(...pts[0]); await page.mouse.down();
  for (const q of pts.slice(1)) await page.mouse.move(...q, { steps: 6 });
  await page.mouse.up();
};
const circleAround = async ([cx, cy], rx, ry) => {
  const pts = []; for (let a = 0; a <= 6.6; a += 0.35) pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  await stroke(pts);
};
const waitIdle = async () => {
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 15 * 60 * 1000 });
  await page.waitForTimeout(2500);   // Modell-Export und Nachladen
};
const overlayClear = async (t) => {
  const px = await page.evaluate(() => window.studioDebug.overlayPixels()), st = await state();
  ok(px === 0 && st.strokes === 0 && !st.current, `${t}: Striche nach dem Senden entfernt` +
    (px || st.strokes || st.current ? ` (Pixel ${px}, Striche ${st.strokes}, offener Strich ${st.current})` : ''));
  if (px || st.strokes || st.current) console.log('     Zeichenprotokoll: ' + JSON.stringify(await page.evaluate(() => window.studioDebug.drawLog())));
  if (px) console.log('     Diagnose: ' + JSON.stringify(await page.evaluate(() => {
    const o = document.querySelector('#overlay'), ctx = o.getContext('2d');
    const d = ctx.getImageData(0, 0, o.width, o.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, col = null;
    for (let i = 3; i < d.length; i += 4) if (d[i]) {
      const k = (i - 3) / 4, x = k % o.width, y = Math.floor(k / o.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      col ??= [d[i - 3], d[i - 2], d[i - 1], d[i]];
    }
    const before = window.studioDebug.overlayPixels();
    o.width = o.width;
    const after = window.studioDebug.overlayPixels();
    return { size: [o.width, o.height], box: [minX, minY, maxX, maxY], col, before, afterReset: after,
             overlays: document.querySelectorAll('canvas').length };
  })));
};
const lastAgentText = () => page.$$eval('#log .msg.agent, #log .msg.error', (e) => e.at(-1)?.textContent || '');

console.log(`Funktionstest (${MODE}) gegen ${URL.replace(/t=[^&]+/, 't=…')}`);
await page.goto(URL);
await page.waitForTimeout(2500);
ok(await page.locator('#conn.on').count() === 1, 'WebSocket-Verbindung zum Studio steht');
ok(await page.evaluate(() => !!window.studioDebug), 'Oberfläche geladen (three.js, Testschnittstelle)');

if (MODE === 'smoke') {
  const box = await vp();
  await circleAround([box.x + box.width * 0.45, box.y + box.height * 0.5], 50, 35);
  let s = await state();
  ok(s.strokes === 1 && !s.current, 'Strich wird als ein abgeschlossener Strich erkannt');
  const info = await page.textContent('#markinfo');
  ok(/1 Strich/.test(info), `Anzeige der Markierung: "${info}"`);
  // Linienfarben: Farbe je Strich, in den Strichdaten und im übertragenen Bild
  await page.click('#palette [data-color="blau"]');
  ok((await state()).color === 'blau', 'Farbwahl: Blau ist aktiv');
  await stroke([[box.x + box.width * 0.2, box.y + box.height * 0.3], [box.x + box.width * 0.35, box.y + box.height * 0.35]]);
  s = await state();
  ok(JSON.stringify(s.strokeColors) === '["rot","blau"]', `Jeder Strich behält seine Farbe: ${JSON.stringify(s.strokeColors)}`);
  const marks = await page.evaluate(() => window.studioDebug.marks());
  ok(marks.map((m) => m.farbe).join() === 'rot,blau', 'Strichdaten für die KI enthalten die Farbe je Strich');
  ok(await page.evaluate(() => window.studioDebug.imageHasColor('#2f8cff')) > 30, 'Übertragenes Bild enthält den blauen Strich');
  ok(/1× rot, 1× blau/.test(await page.textContent('#markinfo')), 'Anzeige zählt Striche je Farbe');
  ok(await page.locator('#palette button').count() === 6, 'Palette mit 6 Farben');
  await page.click('#palette [data-color="rot"]');
  await page.screenshot({ path: path.join(OUT, 'smoke-strich.png') });
  await page.click('#clear');

  // S Pen: Druck, Radierer, Handballen, Finger navigiert (echte Ereignisse über DevTools)
  const cam = () => page.evaluate(() => window.studioDebug.camera().join());
  const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
  await pen(line(cx - 150, cy - 100, cx + 150, cy - 100, 20, 0.1, 1.0));
  s = await state();
  const pr = s.pressures[0] || [];
  ok(s.strokes === 1 && Math.max(...pr) - Math.min(...pr) > 0.6, `Stift zeichnet mit Druck (${Math.min(...pr).toFixed(2)}…${Math.max(...pr).toFixed(2)})`);
  await pen(line(cx - 150, cy - 60, cx + 150, cy - 60, 10));
  ok((await state()).strokes === 2, 'Zweiter Stiftstrich');
  await page.click('#undostroke');
  ok((await state()).strokes === 1, '„↩ Strich“ entfernt nur den letzten Strich');
  await pen(line(cx, cy - 140, cx, cy - 60, 10), { button: 'right', buttons: 2 });
  ok((await state()).strokes === 0, 'Stifttaste gedrückt: Stift radiert');
  await pen(line(cx - 150, cy - 100, cx + 150, cy - 100, 10));
  // Radiererende des Stifts (buttons 32) lässt sich über DevTools nicht erzeugen: Tablet-Prüfliste B4.
  await page.click('[data-tool="eraser"]');
  await pen(line(cx, cy - 140, cx, cy - 60, 10));
  ok((await state()).strokes === 0, 'Werkzeug „Radierer“: Stift radiert beim Darüberziehen');
  await page.click('[data-tool="pen"]');
  let c0 = await cam();
  await touch(line(cx, cy, cx + 200, cy + 50, 10));            // sofort nach dem Stift: Handballen
  ok((await cam()) === c0 && (await state()).strokes === 0, 'Berührung direkt nach dem Stift wird ignoriert (Handballen)');
  await page.waitForTimeout(800);
  c0 = await cam();
  await touch(line(cx, cy, cx + 200, cy + 50, 10), 40);        // große Kontaktfläche
  await page.waitForTimeout(300);
  ok((await cam()) === c0 && (await state()).strokes === 0, 'Große Kontaktfläche wird ignoriert (Handballen)');
  c0 = await cam();
  await touch(line(cx, cy, cx + 200, cy + 50, 10));            // normaler Finger
  await page.waitForTimeout(500);
  ok((await cam()) !== c0 && (await state()).strokes === 0, 'Finger dreht das Modell und zeichnet nicht');
  // Handballen liegt zuerst auf, dann setzt der Stift auf, der Ballen bewegt sich mit
  await page.waitForTimeout(800);
  c0 = await cam();
  const tp = (x, y) => [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 9 }];
  const pe = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent',
    { type, x, y, pointerType: 'pen', force: 0.6, button: 'left', buttons: 1, clickCount: 1, ...extra });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(cx + 200, cy + 150) });
  await pe('mousePressed', cx - 100, cy + 100);
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(cx + 200 + i * 15, cy + 150 + i * 5) });
    await pe('mouseMoved', cx - 100 + i * 20, cy + 100);
  }
  await pe('mouseReleased', cx + 100, cy + 100, { buttons: 0 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  ok((await cam()) === c0 && (await state()).strokes === 1, 'Handballen zuerst, dann Stift: Strich entsteht, Modell bewegt sich nicht');
  await page.click('#clear');
  const inp = await page.evaluate(() => window.studioDebug.input());
  ok(inp.controls && inp.ignoredTouches === 0, 'Navigation nach den Tests wieder frei');
  await page.click('#fit');

  // Sprache in beide Richtungen (Mikrofon-Attrappe spielt testdaten/durchmesser.wav in Schleife)
  const sp = () => page.evaluate(() => window.studioDebug.speech());
  const caps = (await sp()).caps;
  ok(caps.stt && caps.tts, `Spracheingabe und -ausgabe verfügbar (stt ${caps.stt}, tts ${caps.tts})`);
  if (caps.tts) {
    const q = 'Soll die neue Bohrung durchgehend sein?';
    const tts = await page.evaluate(async (text) => {
      const r = await fetch('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const b = await r.arrayBuffer();
      const head = String.fromCharCode(...new Uint8Array(b.slice(0, 4)));
      const echo = await (await fetch('/stt', { method: 'POST', body: b })).json();
      return { status: r.status, bytes: b.byteLength, head, echo };
    }, q);
    ok(tts.status === 200 && tts.head === 'RIFF' && tts.bytes > 40000, `Sprachausgabe liefert WAV (${tts.bytes} Byte)`);
    ok(tts.echo.echo === true && !tts.echo.text, 'Vorgelesener Satz im Mikrofon wird als Echo erkannt und verworfen');
    await page.click('#say');
    ok((await sp()).on === false, '🔊 schaltet das Vorlesen aus');
    await page.evaluate(() => window.studioDebug.say('Das sollte jetzt nicht vorgelesen werden.'));
    await page.waitForTimeout(500);
    ok(!(await sp()).playing && (await sp()).spoken === 0, 'Ausgeschaltet: nichts wird vorgelesen');
    await page.click('#say');
    // Rückfrage vorlesen → danach automatisch zuhören → Antwort ins Eingabefeld
    await page.fill('#text', '');
    await page.evaluate((text) => window.studioDebug.say(text), q);
    await page.waitForFunction(() => window.studioDebug.speech().playing, null, { timeout: 15000 });
    const during = await sp();
    ok(during.playing && !during.recording, 'Während des Vorlesens ist das Mikrofon aus (kein Echo)');
    await page.waitForFunction(() => window.studioDebug.speech().auto, null, { timeout: 20000 });
    ok(!(await sp()).playing, 'Nach der Rückfrage hört das Mikrofon automatisch zu');
    await page.waitForFunction(() => !window.studioDebug.speech().recording && window.studioDebug.speech().text, null, { timeout: 30000 });
    const after = await sp();
    ok(/durchmesser/i.test(after.text), `Gesprochene Antwort steht im Eingabefeld: "${after.text}"`);
    ok(after.spoken >= 1, 'Rückfrage wurde vorgelesen');
    // Dazwischenreden: 🎤 während des Vorlesens beendet die Ausgabe sofort und nimmt auf
    await page.fill('#text', '');
    await page.evaluate(() => window.studioDebug.say('Ich lese jetzt einen etwas längeren Satz vor, damit genug Zeit zum Unterbrechen bleibt, und noch ein bisschen weiter.'));
    await page.waitForFunction(() => window.studioDebug.speech().playing, null, { timeout: 15000 });
    await page.click('#mic');
    await page.waitForTimeout(400);
    const barge = await sp();
    ok(!barge.playing && barge.recording, '🎤 während des Vorlesens: Ausgabe stoppt, Aufnahme startet');
    await page.waitForTimeout(2500);
    await page.click('#mic');
    await page.waitForFunction(() => !window.studioDebug.speech().recording && !document.querySelector('#mic').classList.contains('wait'), null, { timeout: 30000 });
    ok(/durchmesser/i.test((await sp()).text), 'Aufnahme nach dem Unterbrechen wird erkannt');
    await page.fill('#text', '');
  }
  await page.click('#clear');
  s = await state();
  ok(s.strokes === 0, '„Striche löschen“ entfernt alle Striche');
} else {
  await page.click('#new'); await page.waitForTimeout(2500);
  ok((await volume()) === 0, 'Neues, leeres Bauteil');
  await page.click('#top'); await page.waitForTimeout(500);
  await stroke([await toScreen(-30, -20, 0), await toScreen(32, -19, 0), await toScreen(30, 21, 0),
    await toScreen(-31, 20, 0), await toScreen(-30, -20, 0)]);
  for (const cx of [-18, 18]) await circleAround(await toScreen(cx, 0, 0), 14, 14);
  await page.fill('#text', 'Das soll eine Halterung werden. Die Grundplatte ist 60 mal 40 Millimeter groß und 5 Millimeter dick, ' +
    'mittig um den Ursprung, Unterseite auf Z = 0. Hier kommen zwei durchgehende Bohrungen mit 5,5 Millimetern Durchmesser hin, ' +
    '36 mm Abstand zueinander, mittig auf der langen Achse.');
  await page.click('#send'); await waitIdle();
  const v1 = await volume(), soll1 = 60 * 40 * 5 - 2 * Math.PI * 2.75 ** 2 * 5;
  if ((await state()) && (await page.evaluate(() => window.studioDebug.speech().caps.tts)))
    ok(await page.evaluate(() => { const s = window.studioDebug.speech(); return s.spoken >= 1 || s.playing || s.queue > 0; }),
      'Antwort der KI wird vorgelesen');
  ok(Math.abs(v1 - soll1) / soll1 < 0.01, `Runde 1: Platte mit Bohrungen, Volumen ${v1.toFixed(0)} mm³ (Soll ${soll1.toFixed(0)})`);
  console.log('     KI: ' + (await lastAgentText()).slice(0, 200));
  await overlayClear('Runde 1');
  await page.screenshot({ path: path.join(OUT, 'full-1-platte.png') });

  await page.click('#iso'); await page.waitForTimeout(800);
  const c = await toScreen(30, 20, 2.5);
  await circleAround(c, 22, 30);
  await page.fill('#text', 'Diese Kante bekommt eine Rundung mit acht Millimetern Radius.');
  await page.click('#send'); await waitIdle();
  const v2 = await volume(), soll2 = soll1 - (64 - Math.PI * 16) * 5;
  ok(Math.abs(v2 - soll2) < 5, `Runde 2: eingekreiste Kante R 8 gerundet, Volumen ${v2.toFixed(0)} mm³ (Soll ${soll2.toFixed(0)})`);
  console.log('     KI: ' + (await lastAgentText()).slice(0, 200));
  await overlayClear('Runde 2');
  await page.screenshot({ path: path.join(OUT, 'full-2-rundung.png') });

  // Runde 3: zwei Farben mit verschiedenen Aufgaben in einer Runde, Bedeutung nur aus dem Text
  await page.click('#top'); await page.waitForTimeout(500);
  await page.click('#palette [data-color="grün"]');
  await circleAround(await toScreen(0, 10, 5), 16, 16);
  await page.click('#palette [data-color="violett"]');
  await circleAround(await toScreen(-30, -20, 5), 18, 18);
  await page.click('#palette [data-color="rot"]');
  await page.fill('#text', 'Grün ist eine neue durchgehende Bohrung mit 4 mm Durchmesser, genau in der Mitte des grünen Kreises. ' +
    'Violett markiert die senkrechte Eckkante, die bekommt eine Fase von 2 mm.');
  await page.click('#send'); await waitIdle();
  const v3 = await volume(), soll3 = soll2 - Math.PI * 4 * 5 - 2 * 2 / 2 * 5;
  ok(Math.abs(v3 - soll3) < 5, `Runde 3: zwei Farben, zwei Aufgaben: Volumen ${v3.toFixed(0)} mm³ (Soll ${soll3.toFixed(0)})`);
  const lg = (await state()).legend;
  ok(lg['grün'] && lg['violett'], `Farblegende aus dem Text übernommen: ${JSON.stringify(lg)}`);
  ok(!(await page.textContent('#log')).includes('<farblegende'), 'Steuerzeile der Legende ist im Dialog ausgeblendet');
  ok((await page.textContent('#palette')).includes(lg['grün'] || '–'), 'Palette zeigt die Bedeutung an der Farbe');
  console.log('     KI: ' + (await lastAgentText()).slice(0, 200));
  await overlayClear('Runde 3');
  await page.screenshot({ path: path.join(OUT, 'full-3-farben.png') });

  await page.click('#save'); await page.waitForTimeout(2500);
  const saved = (await page.textContent('#toast')) || '';
  ok(/Gespeichert: .*Funktionstest.*\.sc/.test(saved), saved.replace(os.homedir(), '~'));
}

await browser.close();
console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(failed ? 1 : 0);
