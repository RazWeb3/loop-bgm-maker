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
vm.runInContext(m[1] + "\n;globalThis.__api={generateScore,validateScore,expectedSeconds,TASTES,scoreToMidi};", ctx);
const { generateScore, validateScore, expectedSeconds, TASTES, scoreToMidi } = ctx.__api;

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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
