/*
 * app.js — UI glue. All the maths lives in calc.js (pure + tested); this file only
 * reads inputs, calls computeTDEE, and paints the result. Recomputes live on input.
 */
import {
  computeTDEE, plasmaBiochem, buildActivityResult,
  timeToGoal, metNetKcal, lbToKg, kgToLb, inToCm,
  bmi, bmiCategory, macroTargets, dietZone, weightChangeKgPerWeek,
} from "./calc.js";

const $ = (id) => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;
const fmt = (n) => Math.round(n).toLocaleString();
const MACRO_COLORS = { protein: "#5b5bd6", carb: "#1fb6a6", fat: "#e0922f" };

let currentUnits = "metric";
const state = {
  palTouched: false,    // user dragged the base-PAL override
  llmParse: null,       // structured facts from the LLM endpoint (occupationKey, steps, sessions, notes)
  llmParseText: "",     // the exact textarea value that produced llmParse (so edits invalidate it)
};

// ---------------------------------------------------------------- input readers
const getUnits = () => document.querySelector('input[name="units"]:checked').value;
const getSex = () => document.querySelector('input[name="sex"]:checked').value;
const numv = (el, fb = NaN) => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : fb; };

function readWeightKg() {
  const w = numv($("weight"));
  if (!Number.isFinite(w)) return NaN;
  return getUnits() === "imperial" ? lbToKg(w) : w;
}
function readHeightCm() {
  if (getUnits() === "imperial") {
    const tin = (numv($("heightFt"), 0) * 12) + numv($("heightIn"), 0);
    return tin > 0 ? inToCm(tin) : NaN;
  }
  return numv($("heightCm"));
}
function readBodyFatFraction() {
  const bf = parseFloat($("bodyfat").value);
  return Number.isFinite(bf) ? clamp(bf, 1, 70) / 100 : null;
}

// ---------------------------------------------------------------- units handling
function updateUnitLabels(units) {
  const unit = units === "imperial" ? "lb" : "kg";
  const w = document.querySelector('label[for="weight"] [data-unit-weight]');
  const g = document.querySelector('label[for="goal-weight"] [data-unit-weight]');
  if (w) w.textContent = `Weight (${unit})`;
  if (g) g.textContent = `Target weight (${unit})`;
}
function convertFields(to) {
  const conv = (id, f) => { const v = parseFloat($(id).value); if (Number.isFinite(v)) $(id).value = round1(f(v)); };
  if (to === "imperial") {
    conv("weight", kgToLb); conv("goal-weight", kgToLb);
    const cm = parseFloat($("heightCm").value);
    if (Number.isFinite(cm)) { const tin = cm / 2.54; $("heightFt").value = Math.floor(tin / 12); $("heightIn").value = Math.round(tin % 12); }
  } else {
    conv("weight", lbToKg); conv("goal-weight", lbToKg);
    const cm = ((parseFloat($("heightFt").value) || 0) * 12 + (parseFloat($("heightIn").value) || 0)) * 2.54;
    if (cm > 0) $("heightCm").value = round1(cm);
  }
}
function onUnitsChange() {
  const to = getUnits();
  if (to !== currentUnits) { convertFields(to); currentUnits = to; }
  $("height-metric").classList.toggle("hidden", to === "imperial");
  $("height-imperial").classList.toggle("hidden", to !== "imperial");
  updateUnitLabels(to);
  recompute();
}

// ---------------------------------------------------------------- plasma
// Per-session kcal is fully derived from body weight (calc.js); the only choice the
// user makes is replacement (default) vs strict-expenditure-only.
const plasmaStrict = () => $("plasma-strict").checked;

// ---------------------------------------------------------------- main compute
function gatherInput() {
  const weightKg = readWeightKg();
  const heightCm = readHeightCm();
  const age = numv($("age"));
  if (![weightKg, heightCm, age].every(Number.isFinite)) return null;

  const plasmaEnabled = $("plasma-enabled").checked;
  const activityText = $("activity").value;
  // Prefer the LLM structure, but only while the text it was parsed from is unchanged.
  // The math is still done by buildActivityResult (calc.js) — the LLM only gave structure.
  const llmParse = state.llmParse && state.llmParseText === activityText
    ? buildActivityResult(state.llmParse, weightKg) : null;
  return {
    sex: getSex(),
    age, weightKg, heightCm,
    bodyFatFraction: readBodyFatFraction(),
    activityText,
    parse: llmParse,
    manualBasePAL: state.palTouched ? parseFloat($("basePAL").value) : null,
    plasma: {
      enabled: plasmaEnabled,
      sessionsPerWeek: numv($("plasma-sessions"), 0),
      kcalPerSession: null, // always derived from weight in calc.js
      strictExpenditureOnly: plasmaStrict(),
    },
    adaptation: { mode: $("adaptation").value },
  };
}

function recompute() {
  const input = gatherInput();
  if (!input) { $("tdee-value").textContent = "—"; return; }
  const r = computeTDEE(input);

  // headline
  $("tdee-value").textContent = fmt(r.tdee);
  $("tdee-range").textContent = `${fmt(r.rangeLow)}–${fmt(r.rangeHigh)} kcal`;
  $("bmr-value").textContent = fmt(r.bmr);
  $("bmr-method").textContent = r.bmrMethod;
  $("eff-pal").textContent = `${r.effectivePAL.toFixed(2)}×`;

  renderBreakdown(r);
  renderTargets(r);
  renderCrossChecks(r);
  renderParse(r, input);
  renderGoal(r);
  renderPlasma(input);
  renderBMI(input);
  renderDiet(r, input);
  syncBasePAL(r);
}

// Unobtrusive BMI readout in the results panel.
function renderBMI(input) {
  const b = bmi(input.weightKg, input.heightCm);
  $("bmi-value").textContent = Number.isFinite(b) ? `${b.toFixed(1)} · ${bmiCategory(b).label}` : "—";
}

// Diet & macro planner — driven by the slider, computed from the exact TDEE.
function renderDiet(r, input) {
  const offset = numv($("diet-offset"), 0);
  $("diet-tdee").textContent = fmt(r.tdee);
  const leanMassKg = input.bodyFatFraction != null ? input.weightKg * (1 - input.bodyFatFraction) : null;
  const macros = macroTargets({ tdee: r.tdee, offsetKcal: offset, weightKg: input.weightKg, leanMassKg, sex: input.sex });
  const zone = dietZone({ offsetKcal: offset, weightKg: input.weightKg });

  $("diet-target").textContent = fmt(macros.calories);
  const badge = $("diet-goal-badge");
  badge.textContent = zone.label;
  badge.className = "diet-goal tone-" + zone.tone;

  const imperial = getUnits() === "imperial";
  const perWeek = imperial ? kgToLb(zone.kgPerWeek) : zone.kgPerWeek;
  const unit = imperial ? "lb" : "kg";
  $("diet-rate").textContent = offset === 0
    ? "eat at maintenance to hold steady"
    : `${offset > 0 ? "+" : "−"}${Math.abs(offset)} kcal/day → ${perWeek >= 0 ? "+" : "−"}${Math.abs(perWeek).toFixed(2)} ${unit}/week (${zone.pctPerWeek.toFixed(1)}%/wk)`;

  const warnEl = $("diet-warn");
  const warns = [];
  if (zone.tone === "danger") warns.push("⚠️ Faster than ~1%/week of bodyweight — risks muscle loss and a larger metabolic slowdown. A smaller deficit usually keeps more muscle.");
  if (macros.calories < r.bmr) warns.push(`This target (${fmt(macros.calories)} kcal) is below your resting metabolism (${fmt(r.bmr)} kcal) — not sustainable; ease the deficit.`);
  if (macros.note) warns.push(macros.note);
  if (warns.length) { warnEl.innerHTML = warns.join("<br>"); warnEl.classList.remove("hidden"); }
  else warnEl.classList.add("hidden");

  const total = (macros.protein.kcal + macros.carb.kcal + macros.fat.kcal) || 1;
  $("macro-bar").innerHTML = [["protein", macros.protein.kcal], ["carb", macros.carb.kcal], ["fat", macros.fat.kcal]]
    .map(([k, v]) => `<div class="seg ${k}" style="width:${(v / total) * 100}%" title="${k}: ${fmt(v)} kcal"></div>`).join("");

  const pSub = macros.protein.refIsFFM ? `${macros.protein.gPerKgRef} g/kg lean mass` : `${macros.protein.gPerKgRef} g/kg body wt`;
  const rows = [
    { name: "Protein", color: "#5b5bd6", m: macros.protein, sub: pSub },
    { name: "Carbs", color: "#1fb6a6", m: macros.carb, sub: `${macros.carb.gPerKg} g/kg` },
    { name: "Fat", color: "#e0922f", m: macros.fat, sub: `${macros.fat.gPerKg} g/kg` },
  ];
  $("macro-table").innerHTML = rows.map((row) => `
    <div class="macro-row">
      <div class="m-name"><span class="dot" style="background:${row.color}"></span>${row.name}<span class="m-sub"> · ${row.sub}</span></div>
      <div class="m-cell"><span class="m-lab">grams</span><span class="m-grams">${fmt(row.m.g)} g</span></div>
      <div class="m-cell"><span class="m-lab">calories</span>${fmt(row.m.kcal)}</div>
      <div class="m-cell"><span class="m-lab">% of cals</span>${row.m.pct}%</div>
    </div>`).join("");
}

// Transparent per-session derivation for the plasma modifier.
function renderPlasma(input) {
  const el = $("plasma-breakdown");
  if (!input || !$("plasma-enabled").checked) { el.innerHTML = ""; return; }
  const b = plasmaBiochem(input.weightKg);
  const strict = plasmaStrict();
  const perSession = strict ? b.synthKcal : b.total;
  el.innerHTML = `
    <div class="pb-row"><span>Plasma kept (≈ by weight)</span><b>${b.volumeMl} mL</b></div>
    <div class="pb-row"><span>Protein removed</span><b>${b.proteinG} g</b></div>
    <div class="pb-row"><span>Caloric content · 4 kcal/g</span><b>${strict ? "excluded" : b.contentKcal + " kcal"}</b></div>
    <div class="pb-row"><span>Synthesis cost · 2.2 kcal/g</span><b>${b.synthKcal} kcal</b></div>
    <div class="pb-row total"><span>Per session</span><b>${fmt(perSession)} kcal</b></div>`;
}

// ---------------------------------------------------------------- renderers
function renderBreakdown(r) {
  const f = r.adaptationFactor;
  const segs = [
    { key: "bmr", label: "Resting (BMR)", val: r.bmr * f, color: "var(--seg-bmr)" },
    { key: "base", label: "Daily living + NEAT", val: (r.baseTDEE - r.bmr) * f, color: "var(--seg-base)" },
    { key: "ex", label: "Exercise", val: r.exerciseKcalDaily * f, color: "var(--seg-ex)" },
    { key: "steps", label: "Steps", val: r.stepsKcalDaily * f, color: "var(--seg-steps)" },
    { key: "plasma", label: "Plasma", val: r.plasmaKcalDaily * f, color: "var(--seg-plasma)" },
  ].filter((s) => s.val > 0.5);
  const total = segs.reduce((a, s) => a + s.val, 0) || 1;

  $("breakdown").innerHTML = segs
    .map((s) => `<div class="seg" style="width:${(s.val / total) * 100}%;background:${s.color}" title="${s.label}: ${fmt(s.val)} kcal"></div>`)
    .join("");

  let legend = segs.map((s) =>
    `<li><span class="dot" style="background:${s.color}"></span>${s.label}<span class="amt">${fmt(s.val)}</span></li>`).join("");
  if (Math.abs(f - 1) > 0.001) {
    const pct = Math.round((f - 1) * 100);
    legend += `<li style="grid-column:1/-1;color:var(--warn)"><span class="dot" style="background:var(--warn)"></span>Adaptive thermogenesis applied: ${pct > 0 ? "+" : ""}${pct}% across all components</li>`;
  }
  $("breakdown-legend").innerHTML = legend;
}

function renderTargets(r) {
  const rows = [
    { label: "Maintenance", delta: 0, cls: "maintain" },
    { label: "Mild loss (−250)", delta: -250 },
    { label: "Loss (−500)", delta: -500 },
    { label: "Aggressive loss (−1000)", delta: -1000 },
    { label: "Mild gain (+250)", delta: 250 },
    { label: "Gain (+500)", delta: 500 },
  ];
  $("targets").innerHTML = rows.map((row) =>
    `<div class="target ${row.cls || ""}"><span class="label">${row.label}</span><span class="val">${fmt(r.tdee + row.delta)}</span></div>`
  ).join("");
}

function renderCrossChecks(r) {
  const using = r.bmrMethod;
  const rows = [];
  rows.push({ label: "Mifflin-St Jeor (BMR)", val: `${fmt(r.alternatives.mifflin)} kcal`, active: using.startsWith("Mifflin") });
  if (r.alternatives.katchMcArdle != null) {
    rows.push({ label: "Katch-McArdle (BMR)", val: `${fmt(r.alternatives.katchMcArdle)} kcal`, active: using.startsWith("Katch") });
    rows.push({ label: "FFM eq. 23.9·FFM+372 (BMR)", val: `${fmt(r.alternatives.ffmEquation)} kcal` });
  }
  if (r.pontzerCrossCheck != null) {
    rows.push({ label: "Pontzer 2021 (total, FFM)", val: `${fmt(r.pontzerCrossCheck)} kcal`, note: "free-living, average activity" });
  }
  $("crosschecks").innerHTML = rows.map((row) =>
    `<div class="cc"><span class="cc-label">${row.label}${row.active ? " ✓ in use" : ""}${row.note ? `<span class="cc-note">${row.note}</span>` : ""}</span><span class="cc-val">${row.val}</span></div>`
  ).join("");
}

function renderParse(r, input) {
  const p = r.parse;
  const wkg = input.weightKg;
  const chips = [];
  const occWord = { desk: "desk / seated", student: "student", standing: "standing job", active_job: "active job", labor: "manual labor" }[p.occupation.key] || p.occupation.key;
  chips.push(`<span class="chip ${p.occupation.assumed ? "warn" : ""}">Job: ${occWord} · PAL ${p.basePAL.toFixed(2)}</span>`);

  for (const s of p.sessions) {
    const perDay = metNetKcal(s.met, wkg, s.minutes) * s.daysPerWeek / 7;
    chips.push(`<span class="chip ex">${s.activity} · ${s.daysPerWeek}×/wk · ${s.minutes}min → +${fmt(perDay)}/day</span>`);
  }
  if (p.steps) chips.push(`<span class="chip ex">${fmt(p.steps)} steps/day → +${fmt(r.stepsKcalDaily)}/day</span>`);

  let html = chips.join("");
  if (p.notes.length) html += `<p class="parse-note">${p.notes.map((n) => "· " + n).join("<br>")}</p>`;
  $("parse-output").innerHTML = html;
}

function syncBasePAL(r) {
  if (!state.palTouched) {
    $("basePAL").value = r.basePAL;
    $("basePAL-val").textContent = `auto (${r.basePAL.toFixed(2)})`;
  } else {
    $("basePAL-val").textContent = parseFloat($("basePAL").value).toFixed(2);
  }
}

function renderGoal(r) {
  const out = $("goal-output");
  const gw = parseFloat($("goal-weight").value);
  if (!Number.isFinite(gw)) { out.innerHTML = ""; return; }
  const targetKg = getUnits() === "imperial" ? lbToKg(gw) : gw;
  const currentKg = readWeightKg();
  const offset = parseFloat($("goal-rate").value);
  const losing = offset < 0;
  const shouldLose = targetKg < currentKg;
  if (Math.abs(targetKg - currentKg) < 0.1) { out.innerHTML = `<strong>You're already at your target weight.</strong>`; return; }
  if (losing !== shouldLose) {
    out.innerHTML = `<span style="color:var(--warn)">⚠️ Your target is ${shouldLose ? "below" : "above"} your current weight, but the offset is a ${losing ? "deficit" : "surplus"}. Pick a matching offset.</span>`;
    return;
  }
  const g = timeToGoal({ currentKg, targetKg, dailyDeltaKcal: offset });
  const date = new Date(Date.now() + g.days * 86400000);
  const unit = getUnits() === "imperial" ? "lb" : "kg";
  const shown = getUnits() === "imperial" ? kgToLb : (x) => x;
  out.innerHTML = `At <strong>${fmt(r.tdee + offset)} kcal/day</strong> (${offset > 0 ? "+" : ""}${offset}), reaching
    <strong>${round1(shown(targetKg))} ${unit}</strong> takes about <strong>${Math.round(g.weeks)} weeks</strong>
    (~${date.toLocaleDateString(undefined, { month: "short", year: "numeric" })}), losing/gaining ~${round1(shown(g.kgPerDay) * 7)} ${unit}/week.
    <span class="muted">Linear 7700&nbsp;kcal/kg model — real loss slows as you adapt.</span>`;
}

// ---------------------------------------------------------------- wiring
// ---------------------------------------------------------------- citations
// Each [tag] used in the Research section / reference list → its source. Published
// works point at the canonical URL printed in the PDF; provided-only docs point at a
// bundled copy in /sources. linkifyCitations() wraps every <cite> and reference tag.
const CITES = {
  "Problems": "sources/problems-with-modern-tdee.pdf",
  "Estimating": "sources/estimating-energy-expenditure.pdf",
  "One2One": "sources/resting-energy-expenditure-one2one.pdf",
  "Pontzer 2021": "sources/pontzer-2021-daily-energy-expenditure-life-course.pdf",
  "Trexler 2014": "https://doi.org/10.1186/1550-2783-11-7",
  "Computational": "sources/computational-methods-with-met.txt",
  "StatPearls": "https://www.ncbi.nlm.nih.gov/books/NBK531504/",
  "Deranged Physiology": "https://derangedphysiology.com/main/cicm-primary-exam/haematological-system/Chapter-016/constituents-and-functions-plasma",
  "Maynard": "https://www.maynardlifeoutdoors.com/2010/09/calories-in-human-blood_15.html",
  "Columbia": "https://www.cuimc.columbia.edu/news/surprising-benefits-donating-blood",
  "UCSD": "https://www.medicaldaily.com/why-donating-blood-good-your-health-246379",
  "SBS": "https://www.strongerbyscience.com/protein-science/",
  "Roberts 2020": "https://doi.org/10.2478/hukin-2019-0096",
  "Carb Need": "https://doi.org/10.1017/S0007114516003949",
  "Bulk/Cut": "https://www.healthline.com/nutrition/bulking-vs-cutting",
  "Nutrient Timing": "sources/issn-nutrient-timing-position-stand.pdf",
};
function linkifyCitations() {
  const key = (s) => s.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  document.querySelectorAll(".research cite, .refs .tag").forEach((el) => {
    if (el.querySelector("a")) return;
    const url = CITES[key(el.textContent)];
    if (!url) return;
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.title = "Source: " + key(el.textContent);
    while (el.firstChild) a.appendChild(el.firstChild);
    el.appendChild(a);
  });
}

// ---------------------------------------------------------------- LLM parser
function setAiStatus(msg, cls) {
  const el = $("ai-status");
  el.textContent = msg;
  el.className = "ai-status" + (cls ? " " + cls : "");
}

const AI_TIMEOUT_MS = 15000; // client-side backstop so a hung request can't stall us

/**
 * Seamless failover: drop any AI parse and let the tested, offline regex engine
 * (parseActivity, invoked inside computeTDEE when no parse is supplied) produce an
 * INSTANT result. Called for every AI failure mode — 429/500/503, bad payload,
 * network error, or timeout — so the calculator always answers.
 */
function useLocalParser(statusMsg, tone = "warn") {
  state.llmParse = null;
  state.llmParseText = "";
  setAiStatus(statusMsg, tone);
  recompute(); // routes the user's text straight into the local parseActivity engine
}

// POST the free text to the Claude-backed endpoint. ANY failure → instant local fallback.
async function runAIParse() {
  const text = $("activity").value.trim();
  const weightKg = readWeightKg();
  if (!text) { setAiStatus("Type your week first.", "muted"); return; }
  if (!Number.isFinite(weightKg)) { setAiStatus("Enter your weight first.", "warn"); return; }

  setAiStatus("Reading your week…", "loading");
  $("ai-parse").disabled = true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch("/api/parse-activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, weightKg }),
      signal: controller.signal,
    });

    // Any non-2xx (429 rate-limit, 500, 503 provider_unavailable, …) ⇒ AI is down.
    if (!r.ok) {
      useLocalParser(r.status === 429
        ? "AI is busy (rate limit) — used the instant local parser."
        : "AI unavailable — used the instant local parser.");
      return;
    }
    const data = await r.json().catch(() => null);
    if (!data || data.ok !== true) { useLocalParser("AI unavailable — used the instant local parser."); return; }

    state.llmParse = {
      occupationKey: data.occupationKey,
      steps: data.steps,
      sessions: data.sessions || [],
      notes: ["✨ Structured by AI — calories still computed by the engine.", ...(data.notes || [])],
    };
    state.llmParseText = $("activity").value;
    setAiStatus("Parsed by AI ✓", "ok");
    recompute();
  } catch (err) {
    // network error, DNS/CORS failure, or AbortError (timeout) → fall back instantly
    useLocalParser("AI unreachable — used the instant local parser.");
  } finally {
    clearTimeout(timer);
    $("ai-parse").disabled = false;
  }
}

function init() {
  // live recompute on any field change
  $("calc").addEventListener("input", (e) => {
    if (e.target.id === "basePAL") { state.palTouched = true; }
    // Editing the description invalidates a prior AI parse (revert to regex until re-run).
    if (e.target.id === "activity") {
      if (state.llmParseText !== $("activity").value) { state.llmParse = null; setAiStatus("", ""); }
    }
    recompute();
  });
  $("calc").addEventListener("change", recompute);

  document.querySelectorAll('input[name="units"]').forEach((el) => el.addEventListener("change", onUnitsChange));

  $("plasma-enabled").addEventListener("change", (e) => {
    $("plasma-fields").classList.toggle("hidden", !e.target.checked);
    recompute();
  });

  $("basePAL-reset").addEventListener("click", () => { state.palTouched = false; recompute(); });
  $("ai-parse").addEventListener("click", runAIParse);
  $("diet-offset").addEventListener("input", recompute);

  // body-fat helper emphasis
  $("bodyfat").addEventListener("input", () => {
    const has = Number.isFinite(parseFloat($("bodyfat").value));
    $("bodyfat-help").innerHTML = has
      ? `Using <strong>Katch-McArdle</strong> (lean-mass based). Cross-checked against the FFM equation and Pontzer's power law on the right.`
      : `Leave blank to use <strong>Mifflin-St Jeor</strong>. Enter a value to switch to the lean-mass <strong>Katch-McArdle</strong> equation — more accurate for lifters and anyone whose body composition is far from average.`;
  });

  updateUnitLabels("metric");
  linkifyCitations();
  recompute();
}

document.addEventListener("DOMContentLoaded", init);
