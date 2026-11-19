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

const MODE = process.argv.includes('--full') ? 'full' : 'smoke';
const CACHE = path.join(os.homedir(), 'CAD/ai-studio/.cache');
const URL = process.env.STUDIO_URL || fs.readFileSync(path.join(CACHE, 'studio-url.txt'), 'utf8').trim();
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 7979);
const OUT = path.resolve('ergebnis');
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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 875 } });
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
  await page.screenshot({ path: path.join(OUT, 'smoke-strich.png') });
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
  ok(Math.abs(v1 - soll1) / soll1 < 0.01, `Runde 1: Platte mit Bohrungen, Volumen ${v1.toFixed(0)} mm³ (Soll ${soll1.toFixed(0)})`);
  console.log('     KI: ' + (await lastAgentText()).slice(0, 200));
  await page.screenshot({ path: path.join(OUT, 'full-1-platte.png') });

  await page.click('#iso'); await page.waitForTimeout(800);
  const c = await toScreen(30, 20, 2.5);
  await circleAround(c, 22, 30);
  await page.fill('#text', 'Diese Kante bekommt eine Rundung mit acht Millimetern Radius.');
  await page.click('#send'); await waitIdle();
  const v2 = await volume(), soll2 = soll1 - (64 - Math.PI * 16) * 5;
  ok(Math.abs(v2 - soll2) < 5, `Runde 2: eingekreiste Kante R 8 gerundet, Volumen ${v2.toFixed(0)} mm³ (Soll ${soll2.toFixed(0)})`);
  console.log('     KI: ' + (await lastAgentText()).slice(0, 200));
  await page.screenshot({ path: path.join(OUT, 'full-2-rundung.png') });

  await page.click('#save'); await page.waitForTimeout(2500);
  const saved = (await page.textContent('#toast')) || '';
  ok(/Gespeichert: .*Funktionstest.*\.sc/.test(saved), saved.replace(os.homedir(), '~'));
}

await browser.close();
console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(failed ? 1 : 0);
