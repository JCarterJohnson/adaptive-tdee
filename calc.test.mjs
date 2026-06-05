/*
 * calc.test.mjs — verification harness for the TDEE engine.
 *
 * Every assertion is anchored to a number that is either (a) worked out explicitly
 * in one of the provided sources, or (b) hand-derivable from a formula in them.
 * Run with:  node calc.test.mjs   (exit code 0 = all pass)
 */

import {
  mifflinStJeor, katchMcArdle, ffmRee, leanBodyMass, pontzerTEE, ageFactorOver60,
  metKcalPerMin, metNetKcal, stepsNetKcal, plasmaBiochem, plasmaKcalPerSession, plasmaDailyKcal,
  adaptationFactor, timeToGoal, parseActivity, buildActivityResult, computeTDEE, KCAL_PER_KG,
  bmi, bmiCategory, macroTargets, dietZone, weightChangeKgPerWeek,
} from "./calc.js";

let passed = 0, failed = 0;
const log = (...a) => console.log(...a);

function approx(name, got, want, tol = 0.01) {
  const ok = Math.abs(got - want) <= tol;
  if (ok) { passed++; log(`  ✓ ${name}  (=${round(got)})`); }
  else { failed++; log(`  ✗ ${name}  got ${got}, want ${want} (±${tol})`); }
}
function truthy(name, cond, detail = "") {
  if (cond) { passed++; log(`  ✓ ${name}`); }
  else { failed++; log(`  ✗ ${name}  ${detail}`); }
}
function inRange(name, got, lo, hi) {
  const ok = got >= lo && got <= hi;
  if (ok) { passed++; log(`  ✓ ${name}  (${round(got)} ∈ [${lo}, ${hi}])`); }
  else { failed++; log(`  ✗ ${name}  ${round(got)} not in [${lo}, ${hi}]`); }
}
const round = (x, d = 2) => { const p = 10 ** d; return Math.round(x * p) / p; };
function section(t) { log(`\n${t}`); }

// ---------------------------------------------------------------------------
section("1. Mifflin-St Jeor — [CM] worked example");
// "30-year-old male, 70 kg, 175 cm => 1648.75 kcal/day"
approx("male 70kg/175cm/30y = 1648.75", mifflinStJeor({ weightKg: 70, heightCm: 175, age: 30, sex: "male" }), 1648.75);
// Female differs from male by exactly 166 (the +5 vs -161 constants).
approx("female = male - 166", mifflinStJeor({ weightKg: 70, heightCm: 175, age: 30, sex: "female" }), 1648.75 - 166);

section("2. Katch-McArdle — 370 + 21.6*LBM");
// 80 kg at 20% BF -> LBM 64 -> 370 + 21.6*64 = 1752.4
const lbm = leanBodyMass({ weightKg: 80, bodyFatFraction: 0.20 });
approx("LBM(80kg,20%) = 64", lbm, 64);
approx("Katch-McArdle(LBM 64) = 1752.4", katchMcArdle({ leanBodyMassKg: lbm }), 1752.4);

section("3. FFM cross-check equation — [EEN] 23.9*FFM + 372");
approx("ffmRee(64) = 1901.6", ffmRee({ fatFreeMassKg: 64 }), 1901.6);
truthy("Katch & FFM agree within 150 kcal", Math.abs(katchMcArdle({ leanBodyMassKg: 64 }) - ffmRee({ fatFreeMassKg: 64 })) < 150);

section("4. Pontzer power law — [PON] 0.677*FFM^0.708 (MJ) -> kcal");
// FFM 60 kg -> 0.677*60^0.708 MJ * 239.006. Verify against an independent recompute.
const pManual = 0.677 * Math.pow(60, 0.708) * 239.006;
approx("pontzerTEE(60kg) matches formula", pontzerTEE({ fatFreeMassKg: 60 }), pManual, 0.5);
inRange("pontzerTEE(60kg) is a sane TEE", pontzerTEE({ fatFreeMassKg: 60 }), 2400, 3300);

section("5. Pontzer age factor — flat ≤60, ~-0.7%/yr after");
approx("age 40 factor = 1.0", ageFactorOver60(40), 1.0);
approx("age 60 factor = 1.0", ageFactorOver60(60), 1.0);
approx("age 70 factor = 0.93", ageFactorOver60(70), 0.93);

section("6. MET model — [CM] (MET*kg*3.5)/200");
// "70 kg, MET 8.0 => 9.8 kcal/min"
approx("metKcalPerMin(8, 70) = 9.8", metKcalPerMin(8.0, 70), 9.8);
// Net subtracts 1 MET: (7*70*3.5/200)*60 over an hour
approx("metNetKcal(8MET,70kg,60min) = net of 1 MET", metNetKcal(8.0, 70, 60), ((7 * 70 * 3.5) / 200) * 60, 0.001);
truthy("net < gross", metNetKcal(8, 70, 60) < metKcalPerMin(8, 70) * 60);

section("7. Steps NEAT — weight-scaled net walking");
// 5000 steps @ 80 kg -> 5000*80*0.00038 = 152 kcal
approx("stepsNetKcal(5000,80) = 152", stepsNetKcal(5000, 80), 152);

section("8. Plasma modifier — derived from plasma biochemistry [BLOOD-CAL][PLASMA-*]");
const pl50 = plasmaBiochem(50), pl80 = plasmaBiochem(80), pl115 = plasmaBiochem(115);
// 50 kg -> ~690 mL plasma; 0.69 L * 75 g/L = 51.75 g protein
approx("50kg: ~690 mL plasma collected", pl50.volumeMl, 690, 1);
approx("50kg: ~51.8 g protein removed", pl50.proteinG, 51.8, 0.1);
// content = 51.75*4 + 3.45*9 + 0.69*4 = 240.8; synthesis = 51.75*2.2 = 113.9; total ~355
approx("50kg: content+synthesis ≈ 355", pl50.total, 355, 1);
approx("115kg: content+synthesis ≈ 452", pl115.total, 452, 1);
truthy("bigger donor -> higher per-session", plasmaKcalPerSession(115) > plasmaKcalPerSession(50));
// Plasma sits below whole-blood's ~650 (no hemoglobin lost) but above synthesis-only
inRange("80kg plasma session ~355-455", pl80.total, 380, 420);
truthy("caloric content is the larger half", pl80.contentKcal > pl80.synthKcal);
approx("strict-expenditure mode = synthesis only", plasmaKcalPerSession(80, { strictExpenditureOnly: true }), pl80.synthKcal, 0.5);
truthy("strict expenditure < full replacement", plasmaKcalPerSession(80, { strictExpenditureOnly: true }) < plasmaKcalPerSession(80));
// Daily averaging: 2 sessions/wk at 550 kcal -> 1100/7 ≈ 157.1
approx("plasma daily (2/wk, fixed 550) = 157.14", plasmaDailyKcal({ weightKg: 80, sessionsPerWeek: 2, kcalPerSession: 550 }), 1100 / 7, 0.01);
approx("plasma daily uses derived default when no override", plasmaDailyKcal({ weightKg: 80, sessionsPerWeek: 2 }), (pl80.total * 2) / 7, 0.5);

section("9. Adaptation factor — [TRX] modest, directional");
approx("none = 1.00", adaptationFactor("none"), 1.0);
approx("moderate deficit = 0.95", adaptationFactor("deficit_moderate"), 0.95);
approx("surplus = 1.03", adaptationFactor("surplus"), 1.03);
truthy("deficit lowers, surplus raises", adaptationFactor("deficit_aggressive") < 1 && adaptationFactor("surplus") > 1);

section("10. Goal projection — [CM] 7700 kcal/kg worked example");
// 80 -> 70 kg at 500 kcal/day deficit ≈ 154 days, ≈ 22 weeks
const g = timeToGoal({ currentKg: 80, targetKg: 70, dailyDeltaKcal: -500 });
approx("kg/day = 500/7700", g.kgPerDay, 500 / KCAL_PER_KG, 0.0001);
inRange("days to goal ≈ 154", g.days, 153, 155);
inRange("weeks to goal ≈ 22", g.weeks, 21.5, 22.5);

section("11. NLP parser — the user's own example sentence");
const ex = "I lift weights 4 days a week for an hour, but work a desk job and walk about 5,000 steps a day";
const p = parseActivity(ex, { weightKg: 80 });
truthy("detected desk occupation", p.occupation.key === "desk", `got ${p.occupation.key}`);
approx("desk PAL = 1.40", p.basePAL, 1.4);
truthy("detected 5,000 steps", p.steps === 5000, `got ${p.steps}`);
truthy("exactly one exercise session", p.sessions.length === 1, `got ${p.sessions.length}`);
truthy("session is lifting", p.sessions[0]?.activity === "lifting");
truthy("lifting 4×/week", p.sessions[0]?.daysPerWeek === 4, `got ${p.sessions[0]?.daysPerWeek}`);
truthy("session 60 min", p.sessions[0]?.minutes === 60, `got ${p.sessions[0]?.minutes}`);
truthy("walking did NOT become a separate session", !p.sessions.some((s) => s.activity === "walking"));

section("12. Parser robustness — varied phrasings");
truthy("'twice a week' running", parseActivity("I run twice a week").sessions[0]?.daysPerWeek === 2);
truthy("'every day' = 7", parseActivity("yoga every day for 30 minutes").sessions[0]?.daysPerWeek === 7);
truthy("'10k steps'", parseActivity("I hit 10k steps daily").steps === 10000);
truthy("construction => labor PAL", parseActivity("I do construction work").occupation.key === "labor");
truthy("nurse on feet => active_job", parseActivity("I'm a nurse on my feet all shift").occupation.key === "active_job");
truthy("empty text safe", parseActivity("").sessions.length === 0);

section("12b. buildActivityResult — LLM and regex paths share one roll-up");
// Simulate the structured facts the LLM endpoint returns for the user's example...
const llmFacts = { occupationKey: "desk", steps: 5000, sessions: [{ activity: "lifting", daysPerWeek: 4, minutes: 60 }], notes: [] };
const built = buildActivityResult(llmFacts, 80);
// ...and the regex parse of the same sentence. They must agree to the calorie.
const regexParse = parseActivity("I lift weights 4 days a week for an hour, but work a desk job and walk about 5,000 steps a day", { weightKg: 80 });
approx("same basePAL", built.basePAL, regexParse.basePAL);
approx("same exercise kcal/day", built.dailyExerciseKcal, regexParse.dailyExerciseKcal, 0.01);
approx("same steps kcal/day", built.dailyStepsKcal, regexParse.dailyStepsKcal, 0.01);
truthy("MET filled from table when LLM omits it (lifting = 5.0)", built.sessions[0].met === 5.0);
truthy("active-job step discount applies through shared roll-up",
  buildActivityResult({ occupationKey: "labor", steps: 10000, sessions: [] }, 80).dailyStepsKcal < stepsNetKcal(10000, 80));
truthy("computeTDEE accepts an LLM-derived parse object", (() => {
  const r = computeTDEE({ sex: "male", age: 30, weightKg: 80, heightCm: 178, parse: built });
  return r.tdee > 0 && r.effectivePAL > 1.4;
})());
truthy("bad/unknown activity from LLM is dropped, not crashed",
  buildActivityResult({ occupationKey: "desk", steps: 0, sessions: [{ activity: "lifting", daysPerWeek: 0, minutes: 60 }] }, 80).sessions.length === 0);

section("13. End-to-end computeTDEE — the user's example person");
// Male, 30, 80 kg, 178 cm, no BF% -> Mifflin path.
const full = computeTDEE({
  sex: "male", age: 30, weightKg: 80, heightCm: 178,
  activityText: ex,
});
truthy("uses Mifflin when no BF%", full.bmrMethod.startsWith("Mifflin"));
approx("BMR = Mifflin(80,178,30,m)", full.bmr, Math.round(mifflinStJeor({ weightKg: 80, heightCm: 178, age: 30, sex: "male" })), 1);
inRange("effective PAL is 'active'-ish", full.effectivePAL, 1.45, 1.75);
inRange("TDEE in sane band", full.tdee, 2400, 3200);
truthy("range brackets the point estimate", full.rangeLow < full.tdee && full.tdee < full.rangeHigh);

section("14. computeTDEE switches to Katch-McArdle when BF% present");
const withBf = computeTDEE({
  sex: "male", age: 30, weightKg: 80, heightCm: 178, bodyFatFraction: 0.15,
  activityText: ex,
});
truthy("uses Katch-McArdle with BF%", withBf.bmrMethod.startsWith("Katch"));
truthy("reports lean mass", withBf.leanMassKg === 68);
truthy("provides Pontzer cross-check", typeof withBf.pontzerCrossCheck === "number");
truthy("provides FFM-equation alternative", typeof withBf.alternatives.ffmEquation === "number");

section("15. Plasma + adaptation flow into the final number");
const noPlasma = computeTDEE({ sex: "male", age: 30, weightKg: 80, heightCm: 178, activityText: ex });
const yesPlasma = computeTDEE({
  sex: "male", age: 30, weightKg: 80, heightCm: 178, activityText: ex,
  plasma: { enabled: true, sessionsPerWeek: 2 },
});
truthy("plasma raises TDEE", yesPlasma.tdee > noPlasma.tdee);
const deficit = computeTDEE({
  sex: "male", age: 30, weightKg: 80, heightCm: 178, activityText: ex,
  adaptation: { mode: "deficit_moderate" },
});
truthy("prolonged deficit lowers TDEE ~5%", Math.abs(deficit.tdee - noPlasma.tdee * 0.95) < 1.5);

section("16. BMI — WHO classification");
approx("BMI 80kg/178cm = 25.25", bmi(80, 178), 25.25, 0.05);
truthy("24 = healthy weight", bmiCategory(24).key === "normal");
truthy("27 = overweight", bmiCategory(27).key === "over");
truthy("32 = obese class I", bmiCategory(32).key === "ob1");

section("17. Macro targets — protein per Stronger By Science");
const mMaint = macroTargets({ tdee: 2800, offsetKcal: 0, weightKg: 80, sex: "male" });
approx("maintain male protein = 2.0 g/kg BW", mMaint.protein.gPerKg, 2.0, 0.02);
approx("maintenance calories = TDEE", mMaint.calories, 2800, 1);
approx("maintain female protein = 1.75 g/kg BW", macroTargets({ tdee: 2200, offsetKcal: 0, weightKg: 65, sex: "female" }).protein.gPerKg, 1.75, 0.02);
const mFFM = macroTargets({ tdee: 2800, offsetKcal: 0, weightKg: 80, leanMassKg: 68, sex: "male" });
approx("with BF%: protein = 2.35 g/kg FFM (SBS-preferred)", mFFM.protein.gPerKgRef, 2.35, 0.02);
truthy("protein flagged FFM-based", mFFM.protein.refIsFFM === true);
const mCut = macroTargets({ tdee: 2800, offsetKcal: -1000, weightKg: 80, sex: "male" });
truthy("aggressive cut raises protein toward 3.0 g/kg BW", mCut.protein.gPerKg > 2.7);
approx("cut calories = TDEE - 1000", mCut.calories, 1800, 1);
truthy("macros sum to the calorie target", Math.abs((mMaint.protein.kcal + mMaint.carb.kcal + mMaint.fat.kcal) - mMaint.calories) <= 3);
truthy("fat ≈ 25% of calories at maintenance (Helms 15-25%)", Math.abs(mMaint.fat.pct - 25) <= 2);
truthy("carbs are the remainder — larger on a surplus", macroTargets({ tdee: 2800, offsetKcal: 1000, weightKg: 80, sex: "male" }).carb.g > mMaint.carb.g);
truthy("carbs never negative on an extreme deficit", macroTargets({ tdee: 1600, offsetKcal: -1000, weightKg: 60, leanMassKg: 52, sex: "male" }).carb.g >= 0);

section("18. Diet zone — research-based danger coloring");
truthy("maintenance is neutral", dietZone({ offsetKcal: 0, weightKg: 80 }).tone === "neutral");
truthy("-1000 @ 80kg (~1.1%/wk) = danger", dietZone({ offsetKcal: -1000, weightKg: 80 }).tone === "danger");
truthy("-500 @ 80kg (~0.45%/wk) is a cut, not danger", dietZone({ offsetKcal: -500, weightKg: 80 }).tone !== "danger");
truthy("+300 @ 80kg is a bulk", dietZone({ offsetKcal: 300, weightKg: 80 }).goal === "bulk");
truthy("+1000 @ 80kg = fast bulk caution", dietZone({ offsetKcal: 1000, weightKg: 80 }).tone === "caution");
approx("rate: -500 kcal/day = -0.45 kg/week", weightChangeKgPerWeek(-500), -0.4545, 0.01);

// ---------------------------------------------------------------------------
log(`\n${"=".repeat(48)}`);
log(`  ${passed} passed, ${failed} failed`);
log(`${"=".repeat(48)}`);
process.exit(failed === 0 ? 0 : 1);
