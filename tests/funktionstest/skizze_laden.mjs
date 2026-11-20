// Test „Skizze über Neustarts“ (ohne KI): Ein Projekt wird geöffnet, zwei Striche gezeichnet und als
// gespeicherte Runden abgelegt (neues Format mit vollständigen Strichen und altes Format nur mit
// 3D-Punkten). Nach erneutem Öffnen müssen Skizze, Farben, Blickwinkel und Text zurückkommen.
//
// Läuft nur gegen eine getrennte Test-Instanz (öffnet Dateien), siehe docs/FUNKTIONSTEST.md A4:
//   PROJEKTE=/tmp/studio-test STUDIO_URL=… CONTROL_PORT=7980 node skizze_laden.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const URL = process.env.STUDIO_URL;
const DIR = process.env.PROJEKTE;
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 7980);
if (!URL || !DIR || CONTROL_PORT === 7979) { console.error('Nur gegen eine Test-Instanz: STUDIO_URL, PROJEKTE, CONTROL_PORT setzen.'); process.exit(2); }
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));

let failed = 0;
const ok = (cond, text) => { console.log(`${cond ? 'OK  ' : 'FEHL'} ${text}`); if (!cond) failed++; };

async function control(method, params = {}) {
  const token = fs.readFileSync(path.join(os.homedir(), `.local/share/solidcraft/control/${CONTROL_PORT}.token`), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const s = net.createConnection(CONTROL_PORT, '127.0.0.1');
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.end(); const r = JSON.parse(buf.split('\n')[0]); r.ok ? resolve(r.result) : reject(new Error(r.error)); } });
    s.on('error', reject);
    s.write(JSON.stringify({ id: 1, method, params, token }) + '\n');
  });
}
const exec = (command, params) => control('engine.execute', { command, params });

// Testbauteil: Block 60 × 40 × 10 mm
const sc = path.join(DIR, 'SkizzeLaden.sc');
const studioDir = path.join(DIR, 'SkizzeLaden.studio');
fs.rmSync(studioDir, { recursive: true, force: true });
await exec('file.new', { name: 'SkizzeLaden' });
await exec('solid.box', { name: 'Block', length: '60', width: '40', height: '10' });
await exec('file.save_as', { path: sc });

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.SICHTBAR,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 875 } })).newPage();
page.on('pageerror', (e) => ok(false, 'Seitenfehler: ' + e.message));
const dbg = (fn, arg) => page.evaluate(([f, a]) => window.studioDebug[f](a), [fn, arg]);
const box = async () => page.locator('#viewport').boundingBox();
const toScreen = async (x, y, z) => { const b = await box(); const [sx, sy] = await page.evaluate(([x, y, z]) => window.studioDebug.worldToScreen(x, y, z), [x, y, z]); return [b.x + sx, b.y + sy]; };
const stroke = async (pts) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const q of pts.slice(1)) await page.mouse.move(...q, { steps: 6 }); await page.mouse.up(); };
const openProject = async () => {
  await page.click('#open');
  await page.locator('#files button', { hasText: 'SkizzeLaden' }).first().click();
  await page.waitForTimeout(4000);
};

await page.goto(URL);
await page.waitForFunction(() => window.studioDebug && document.querySelector('#conn.on'));
await openProject();
ok((await dbg('state')).strokes === 0, 'Projekt ohne gespeicherte Runden: keine Skizze');

// Zwei Striche in zwei Farben auf der Oberseite des Blocks
await page.click('#top'); await page.waitForTimeout(800);
await page.click('[data-color="blau"]');
const c = await toScreen(20, 20, 10);
const pts = []; for (let a = 0; a <= 6.6; a += 0.35) pts.push([c[0] + 40 * Math.cos(a), c[1] + 40 * Math.sin(a)]);
await stroke(pts);
await page.click('[data-color="grün"]');
const [a0, a1] = [await toScreen(35, 10, 10), await toScreen(55, 30, 10)];
await stroke([a0, [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2], a1]);
const before = await dbg('state');
const sketch = await dbg('sketch');
const marks = await dbg('marks');
const screens = await dbg('strokeScreens');
ok(before.strokes === 2 && sketch.strokes.length === 2, `Zwei Striche gezeichnet (${before.strokeColors.join(', ')})`);

// Gespeicherte Runden so ablegen, wie das Studio sie schreibt
fs.mkdirSync(studioDir, { recursive: true });
// Ortszeit wie im Studio (datetime.now().isoformat)
const local = (ms) => { const d = new Date(ms); return new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19); };
const future = local(Date.now() + 60_000), past = local(Date.now() - 3600_000);
fs.writeFileSync(path.join(studioDir, 'runde-001.json'), JSON.stringify({ zeit: future, text: 'Test neu', kamera: null, markierungen: marks, skizze: sketch }));

// 1) neue Runde, nach dem letzten Speichern: kommt sofort mit Text zurück
await page.click('#iso'); await page.waitForTimeout(500);
await openProject();
let st = await dbg('state');
ok(st.strokes === 2 && JSON.stringify(st.strokeColors) === JSON.stringify(before.strokeColors), `Ungespeicherte Runde: Striche zurück (${st.strokeColors.join(', ')})`);
ok(await dbg('text') === 'Test neu', 'Ungespeicherte Runde: Text im Eingabefeld');
const again = await dbg('strokeScreens');
const dev = again.length !== screens.length ? Infinity : Math.max(0, ...again.flatMap((s, i) => s.map((p, k) => Math.hypot(p[0] - screens[i][k][0], p[1] - screens[i][k][1]))));
ok(dev < 2, `Blickwinkel wiederhergestellt: Striche liegen wie gezeichnet (Abweichung ${dev.toFixed(2)} px)`);
const pressures = (await dbg('state')).pressures;
ok(pressures[0]?.length === sketch.strokes[0].pr.length, 'Druckwerte je Punkt erhalten');

// 2) Runde vor dem letzten Speichern: nur unter „⤺ Skizze“, Zeichenebene bleibt leer
fs.writeFileSync(path.join(studioDir, 'runde-001.json'), JSON.stringify({ zeit: past, text: 'Test alt', markierungen: marks, skizze: sketch }));
await page.evaluate(() => { document.querySelector('#text').value = ''; });
await openProject();
st = await dbg('state');
ok(st.strokes === 0 && !(await page.locator('#restore').isDisabled()), 'Gespeicherte Runde: Ebene leer, ⤺ Skizze bereit');
await page.click('#restore');
ok((await dbg('state')).strokes === 2, '⤺ Skizze holt sie zurück');

// 3) altes Format (nur 3D-Punkte und SolidCraft-Kamera)
fs.writeFileSync(path.join(studioDir, 'runde-001.json'), JSON.stringify({ zeit: future, text: 'Test altes Format',
  kamera: { target: [30, 20, 10], yaw: 0, pitch: 1.5707, distance: 150, fov_deg: 35 }, markierungen: marks }));
await openProject();
st = await dbg('state');
ok(st.strokes === 2 && JSON.stringify(st.strokeColors) === JSON.stringify(before.strokeColors), 'Altes Rundenformat: Striche aus den 3D-Punkten nachgebildet');

await browser.close();
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen.` : 'Alle Prüfungen bestanden.');
process.exit(failed ? 1 : 0);
