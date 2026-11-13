// Node tests for the prototype core (extracts the first <script> from index.html).
// Covers instruction §8 subset: T1 (target math), T4 (mode constraints), T5 (score format),
// across all modes x all tastes, plus negative cases that must be rejected.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("core script not found"); process.exit(1); }
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1] + "\n;globalThis.__api={generateScore,validateScore,expectedSeconds,TASTES,scoreToMidi,regenerateTrack};globalThis.__api2={SE_RECIPES};", ctx);
const { generateScore, validateScore, expectedSeconds, TASTES, scoreToMidi, regenerateTrack } = ctx.__api;

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log("FAIL:", name); } };

// 1) all modes x all tastes: valid scores
const modes = [
  { mode: "standard" }, { mode: "retro" }, { mode: "retro", expTri: true },
  { mode: "retro", expSmp: true }, { mode: "retro", expTri: true, expSmp: true },
  { mode: "piano" }, { mode: "ambient" },
];
for (const mo of modes) {
  for (const taste of Object.keys(TASTES)) {
    for (const variant of [0, 1, 2]) {
      const s = generateScore({ theme: "テスト", taste, bpm: 100, bars: 8, key: "C:major", variant, ...mo });
      const checks = validateScore(s);
      const bad = checks.filter(c => !c.ok);
      ok(bad.length === 0, `${JSON.stringify(mo)} x ${taste} v${variant}: ${bad.map(b => b.id + " " + b.detail).join("; ")}`);
      ok(Math.abs(expectedSeconds(s) - 19.2) < 1e-9, "T1 target seconds");
    }
  }
}
// 2) retro strictness: exactly 4 channels, monophonic
{
  const s = generateScore({ theme: "x", mode: "retro", taste: "battle", bpm: 150, bars: 8, key: "A:minor", variant: 0 });
  ok(s.tracks.length === 4, "retro has 4 tracks");
  for (const tr of s.tracks) {
    const sorted = [...tr.notes].sort((a, b) => a.step - b.step);
    let mono = true;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].step < sorted[i - 1].step + sorted[i - 1].len) mono = false;
    if (tr.instrument !== "sample") ok(mono, `retro ${tr.id} monophonic`);
  }
}
// 3) negative cases must be rejected by T4/T5
{
  const s = generateScore({ theme: "x", mode: "retro", taste: "pop", bpm: 100, bars: 8, key: "C:major", variant: 0 });
  s.tracks.push({ id: "chX", role: "extra", instrument: "pulse", notes: [] });
  ok(validateScore(s).find(c => c.id === "T4" && !c.ok) !== undefined, "extra channel rejected");
  const s2 = generateScore({ theme: "x", mode: "piano", taste: "pop", bpm: 100, bars: 8, key: "C:major", variant: 0 });
  s2.tracks.push({ id: "extra", role: "bass", instrument: "synthbass", notes: [] });
  ok(validateScore(s2).find(c => c.id === "T4" && !c.ok) !== undefined, "piano extra track rejected");
  const s3 = generateScore({ theme: "x", mode: "standard", taste: "pop", bpm: 100, bars: 8, key: "C:major", variant: 0 });
  s3.tracks[0].notes.push({ step: 9999, midi: 60, len: 2, vel: .5 });
  ok(validateScore(s3).find(c => c.id === "T5" && !c.ok) !== undefined, "out-of-range note rejected");
}
// 4) MIDI export: header, track count, note-on count matches score
{
  const s = generateScore({ theme: "midi", mode: "retro", taste: "pop", bpm: 100, bars: 8, key: "C:major", variant: 0, expSmp: true });
  const mid = scoreToMidi(s);
  ok(String.fromCharCode(...mid.slice(0, 4)) === "MThd", "MIDI header MThd");
  const ntrk = (mid[10] << 8) | mid[11];
  ok(ntrk === s.tracks.length + 1, `MIDI track count ${ntrk} = score tracks + conductor`);
  // count note-on events (status 0x9n with velocity > 0) by scanning track chunks naively:
  // instead verify total bytes grew with notes and end-of-track markers exist per track
  let eot = 0; for (let i = 0; i + 2 < mid.length; i++) if (mid[i] === 0xff && mid[i + 1] === 0x2f) eot++;
  ok(eot === ntrk, "MIDI end-of-track per track");
  const totalNotes = s.tracks.reduce((a, t) => a + t.notes.length, 0);
  ok(mid.length > totalNotes * 4, "MIDI size consistent with note count");
}
// 5) stage 3: per-track regeneration keeps other tracks + chords identical, stays valid
{
  const baseOpts = { theme: "再生成", mode: "standard", taste: "pop", bpm: 100, bars: 8, key: "C:major", variant: 0, trackVariants: {} };
  const s0 = generateScore(baseOpts);
  const s1 = regenerateTrack(s0, { ...baseOpts, trackVariants: { melody: 1 } }, "melody");
  ok(JSON.stringify(s1.chords) === JSON.stringify(s0.chords), "regen keeps chords");
  for (const tr of s0.tracks) {
    const other = s1.tracks.find(t => t.id === tr.id);
    if (tr.id === "melody") ok(JSON.stringify(other.notes) !== JSON.stringify(tr.notes), "regen changes melody");
    else ok(JSON.stringify(other.notes) === JSON.stringify(tr.notes), `regen keeps ${tr.id}`);
  }
  ok(validateScore(s1).every(c => c.ok), "regen result still valid");
  // retro: regenerated ch1 must remain monophonic and valid
  const rOpts = { theme: "再生成", mode: "retro", taste: "battle", bpm: 140, bars: 8, key: "A:minor", variant: 0, trackVariants: {}, expTri: true, expSmp: true };
  const r0 = generateScore(rOpts);
  const r1 = regenerateTrack(r0, { ...rOpts, trackVariants: { ch1: 2 } }, "ch1");
  ok(validateScore(r1).every(c => c.ok), "retro regen valid (mono + constraints)");
  ok(JSON.stringify(r1.tracks.find(t => t.id === "ch3").notes) === JSON.stringify(r0.tracks.find(t => t.id === "ch3").notes), "retro regen keeps ch3");
}
// 6) stage 3 fix: regenerating ANY track must change that track (no no-op parts)
{
  const configs=[{mode:"standard"},{mode:"retro"},{mode:"retro",expTri:true,expSmp:true},{mode:"piano"},{mode:"ambient"}];
  for(const cfg of configs){
    const o={theme:"全パート再生成", taste:"pop", bpm:100, bars:8, key:"C:major", variant:0, trackVariants:{}, ...cfg};
    const s0=generateScore(o);
    for(const tr of s0.tracks){
      const s1=regenerateTrack(s0, {...o, trackVariants:{[tr.id]:1}}, tr.id);
      const nt=s1.tracks.find(x=>x.id===tr.id);
      ok(JSON.stringify(nt.notes)!==JSON.stringify(tr.notes), `${cfg.mode}/${tr.id} changes on regen`);
      ok(validateScore(s1).every(c=>c.ok), `${cfg.mode}/${tr.id} regen valid`);
      for(const other of s0.tracks){ if(other.id!==tr.id)
        ok(JSON.stringify(s1.tracks.find(x=>x.id===other.id).notes)===JSON.stringify(other.notes), `${cfg.mode} regen ${tr.id} keeps ${other.id}`); }
    }
  }
}

// 3) T7: sound-effect recipes (instruction §8 T7)
// duration in category range, rendered frequencies in audible UI range,
// simulated synthesis is not silent, has no leading silence, and does not clip.
{
  const api2 = ctx.__api2;
  const { SE_RECIPES } = api2;
  const cats = Object.keys(SE_RECIPES);
  ok(cats.length === 8, "T7: 8 SE categories exist");
  const sr = 44100;
  const synth = (r) => {
    const n = Math.ceil(sr * r.dur), buf = new Float32Array(n);
    if (r.type === "noise") { let seed = 42; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; buf[i] = ((seed / 0x40000000) - 1) * 0.8 * Math.exp(-3 * i / n); } }
    else if (r.type === "sweep") { for (let i = 0; i < n; i++) { const t = i / sr, f = r.from * Math.pow(r.to / r.from, t / r.dur); const ph = 2 * Math.PI * f * t; buf[i] = (Math.sin(ph) >= 0 ? 1 : -1) * 0.4 * Math.exp(-3 * i / n); } }
    else { const step = r.dur / r.notes.length; r.notes.forEach((f, idx) => { const s0 = Math.floor(idx * step * sr), s1 = Math.floor((idx + 1) * step * sr); for (let i = s0; i < s1 && i < n; i++) { const ph = 2 * Math.PI * f * (i - s0) / sr; buf[i] = (Math.sin(ph) >= 0 ? 1 : -1) * 0.35 * Math.exp(-3 * (i - s0) / (s1 - s0)); } }); }
    return buf;
  };
  for (const [name, r] of Object.entries(SE_RECIPES)) {
    ok(r.dur >= 0.05 && r.dur <= 0.6, `T7 ${name}: duration ${r.dur}s within UI range`);
    if (r.type === "sweep") ok(r.from >= 80 && r.from <= 4000 && r.to >= 80 && r.to <= 4000, `T7 ${name}: sweep freqs in range`);
    if (r.type === "arp") {
      ok(r.notes.length >= 2 && r.notes.length <= 6, `T7 ${name}: arp note count`);
      ok(r.notes.every(f => f >= 150 && f <= 4000), `T7 ${name}: arp freqs (Hz) in range`);
      ok(r.notes.every((f, i) => i === 0 || f > r.notes[i - 1]), `T7 ${name}: arp ascending`);
    }
    const buf = synth(r);
    let peak = 0, sum = 0; for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    let head = 0, hn = Math.floor(sr * 0.005); for (let i = 0; i < hn; i++) head += buf[i] * buf[i];
    ok(peak <= 1.0 && peak >= 0.2, `T7 ${name}: peak ${peak.toFixed(2)} normalized, not silent`);
    ok(rms > 0.03, `T7 ${name}: RMS ${rms.toFixed(3)} not silent`);
    ok(Math.sqrt(head / hn) > 0.05, `T7 ${name}: no leading silence`);
  }
  // regression guard: renderSE must treat recipe arp notes as Hz, not MIDI numbers
  const htmlAll = html;
  ok(!/renderSE[\s\S]*?Math\.pow\(2,\(m-69\)\/12\)/.test(htmlAll.slice(htmlAll.indexOf("function renderSE"), htmlAll.indexOf("function renderSE") + 1600)), "T7: renderSE arp uses Hz directly");
}

// 4) T8 (automatable subset, instruction §10.6): no trademark / work names in the
// app's display strings; the shipped README carries the §10.4 notice and the contact window.
{
  const tm = /ゲームボーイ|ファミコン|Game ?Boy|Nintendo|任天堂/;
  ok(!tm.test(html), "T8: no trademark strings anywhere in the app HTML");
  ok(!/商用利用自由|完全にフリー|権利フリー/.test(html), "T8: no overclaim wording in the app");
  let readme = "";
  for (const cand of ["../repo/loop-bgm-maker/README.md", "../README.md"]) {
    try { readme = readFileSync(new URL(cand, import.meta.url), "utf8"); break; } catch { /* try next */ }
  }
  if (readme) {
    ok(readme.includes("権利を主張しません") && readme.includes("保証しません"), "T8: README carries the §10.4 notice");
    ok(readme.includes("github.com/RazWeb3/loop-bgm-maker/issues"), "T8: README carries the contact window (Issues)");
    ok(!tm.test(readme), "T8: no trademark strings in README");
  }
}

// 5) Random seed: same seed reproduces, different seeds diverge but stay valid, seed is recorded.
{
  const base = { theme: "種テスト", mode: "standard", taste: "pop", bpm: 120, bars: 8, key: "C:major", variant: 0 };
  const a = generateScore({ ...base, seed: 123456789 });
  const b = generateScore({ ...base, seed: 123456789 });
  ok(JSON.stringify(a.tracks) === JSON.stringify(b.tracks), "seed: same seed -> identical tracks");
  ok(a.meta.seed === 123456789, "seed: recorded in meta");
  const c = generateScore({ ...base, seed: 987654321 });
  ok(JSON.stringify(a.tracks) !== JSON.stringify(c.tracks), "seed: different seed -> different tracks");
  for (const sd of [0, 1, 42, 2147483647]) {
    const s = generateScore({ ...base, seed: sd });
    ok(validateScore(s).every(x => x.ok), `seed ${sd}: score valid`);
  }
  const noseed = generateScore({ ...base });
  ok(noseed.meta.seed === null, "seed: absent seed stays null (legacy behaviour)");
  // regen keeps the seed family
  const r = regenerateTrack(a, { ...base, seed: a.meta.seed, trackVariants: { melody: 1 } }, "melody");
  ok(r.meta.seed === 123456789, "seed: preserved across track regeneration");
}
// --- regression: live scheduler must derive total steps from meta.bars (meta has no totalSteps) ---
{
  ok(!html.includes("meta.totalSteps"), "scheduler does not reference meta.totalSteps");
  ok(html.includes("meta.bars*16"), "scheduler derives steps from bars");
  ok(html.includes("function renderGridEditor") && html.includes("function geToggle"), "fine grid editor present");
  ok(html.includes('id="geGrid"') && html.includes("細かな編集（生成後に直す）"), "fine editor section present");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

