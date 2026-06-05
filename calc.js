/*
 * calc.js — research-grounded TDEE engine (framework-free ES module).
 *
 * Imported by BOTH the browser UI (index.html, <script type="module">) and the
 * Node verification harness (calc.test.mjs). Keep it pure: no DOM, no Node APIs,
 * no globals. Every constant below is traceable to one of the six provided sources:
 *
 *   [CM]   844593978-Computational-Methods-with-MET.txt   (Mifflin sample, MET, 7700 kcal/kg)
 *   [EEN]  estimating_energy_-expenditure.pdf             (Mifflin recommended; FFM eq; PAL tables)
 *   [O2O]  ESSCO2O Resting Energy Expenditure sheet       (REE 60-70% TEE; FFM drives REE; age decline)
 *   [PMT]  Problems with modern TDEE.pdf                  (population error 10-20%; Katch-McArdle; NEAT)
 *   [PON]  nihms-1718676 / Pontzer 2021 Science           (TEE=0.677*FFM^0.708; ±20% residual; >60 decline)
 *   [TRX]  Trexler 2014 JISSN                             (adaptive thermogenesis; refeed +7%)
 */

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

export const KCAL_PER_MJ = 239.006;            // 1 megajoule = 239.006 kcal (for [PON] power law)
export const KCAL_PER_KG = 7700;               // energy density of body-mass change [CM]
export const LB_PER_KG = 2.2046226218;
export const CM_PER_IN = 2.54;

// Honest prediction band. [PMT] states an individual can sit 10-20% above/below a
// population equation (its worked example, 2800 -> ~2400-3200, is ~±15%); [PON] finds
// >±20% residual variation even after controlling for FFM, fat mass, sex and age.
// We surface a deliberately conservative ±12% band and explain the wider tail in the UI.
export const UNCERTAINTY_BAND = 0.12;

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lbToKg = (lb) => lb / LB_PER_KG;
export const kgToLb = (kg) => kg * LB_PER_KG;
export const inToCm = (inches) => inches * CM_PER_IN;
const round = (x, d = 0) => {
  const p = 10 ** d;
  return Math.round(x * p) / p;
};

// ----------------------------------------------------------------------------
// Resting-metabolism equations
// ----------------------------------------------------------------------------

/**
 * Mifflin-St Jeor (1990). The DEFAULT when body-fat % is unknown.
 * [EEN] recommends it as "the most accurate predictor of energy expenditure in
 * non-obese and obese individuals compared to direct calorimetry," and notes the
 * older Harris-Benedict equation tends to OVERESTIMATE, especially in obese people.
 *
 *   Male:   REE = 10*kg + 6.25*cm - 5*age + 5
 *   Female: REE = 10*kg + 6.25*cm - 5*age - 161
 */
export function mifflinStJeor({ weightKg, heightCm, age, sex }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "female" ? base - 161 : base + 5;
}

/**
 * Katch-McArdle — PRIORITISED whenever the user supplies a body-fat %.
 *
 * Why prioritise it: [PMT] and [O2O] both stress that fat-free mass (FFM), not
 * total weight, is what actually correlates with resting metabolism. Two 180 lb
 * people at 10% vs 30% body fat have different metabolic demands; equations that
 * use only total weight (Mifflin, Harris-Benedict) cannot see that difference.
 *
 * Formula:
 *     LBM (lean body mass, kg) = weight * (1 - bodyFatFraction)
 *     BMR = 370 + 21.6 * LBM
 *
 * The 21.6 kcal/kg slope is the per-kilogram resting cost of lean tissue and 370
 * is the intercept. Note this equation has NO age or height term — lean mass alone
 * carries the signal — which is exactly why we add a separate [PON] age correction
 * for older adults below (ageFactorOver60), since Katch-McArdle would otherwise be
 * age-blind.
 */
export function katchMcArdle({ leanBodyMassKg }) {
  return 370 + 21.6 * leanBodyMassKg;
}

/**
 * FFM equation provided verbatim in [EEN]:  REE = 23.9 * FFM + 372.
 * A near-sibling of Katch-McArdle (21.6*LBM + 370). We compute it purely as an
 * independent CROSS-CHECK so the user can see two lean-mass methods agree.
 */
export function ffmRee({ fatFreeMassKg }) {
  return 23.9 * fatFreeMassKg + 372;
}

/** Lean body mass from weight and a body-fat FRACTION (0..1). */
export function leanBodyMass({ weightKg, bodyFatFraction }) {
  return weightKg * (1 - bodyFatFraction);
}

/**
 * Pontzer et al. 2021 (Science) life-course power law for *total* free-living
 * expenditure as a function of fat-free mass:
 *     TEE (MJ/day) = 0.677 * FFM^0.708     (r^2 = 0.83)
 * Returned here in kcal/day. Because the doubly-labelled-water database already
 * includes each subject's habitual physical activity, this is NOT a BMR — we use
 * it only as an independent, body-composition-based sanity anchor for total TDEE.
 */
export function pontzerTEE({ fatFreeMassKg }) {
  return 0.677 * Math.pow(fatFreeMassKg, 0.708) * KCAL_PER_MJ;
}

/**
 * [PON] age handling. Size-adjusted expenditure is essentially FLAT from 20-60 y,
 * then declines ~0.7%/yr after ~60. We apply this only to the Katch-McArdle path
 * (which has no age term); Mifflin already carries its own validated age slope, so
 * applying it there too would double-count.
 */
export function ageFactorOver60(age) {
  if (age <= 60) return 1;
  return clamp(1 - 0.007 * (age - 60), 0.6, 1);
}

// ----------------------------------------------------------------------------
// Activity energy (MET model) — [CM]
// ----------------------------------------------------------------------------

/** Gross kcal/min of an activity:  (MET * kg * 3.5) / 200  [CM]. */
export function metKcalPerMin(met, weightKg) {
  return (met * weightKg * 3.5) / 200;
}

/**
 * NET activity calories above rest. We subtract 1 MET (resting) because the
 * resting metabolism burned during the workout hour is ALREADY captured by
 * BMR * occupationalPAL. Adding gross METs on top would double-count that hour's
 * resting burn. This mirrors how the [EEN] PAL framework treats sport as an
 * increment "+0.3" on top of a baseline lifestyle PAL rather than a replacement.
 */
export function metNetKcal(met, weightKg, minutes) {
  const net = Math.max(0, met - 1);
  return ((net * weightKg * 3.5) / 200) * minutes;
}

/**
 * Net walking calories from a daily step count, scaled by body weight.
 * Net walking cost ~0.5 kcal/kg/km; an average step ~0.76 m, so per step per kg
 * ~ 0.5 * 0.00076 = 0.00038 kcal. (Gross is ~double; we keep the NET portion so it
 * stacks cleanly on top of the resting metabolism already in the base PAL.)
 */
export function stepsNetKcal(steps, weightKg) {
  return steps * weightKg * 0.00038;
}

// MET values (ACSM-consistent) for activities the parser recognises.
export const MET_TABLE = {
  walking: 3.5,
  jogging: 7.0,
  running: 9.8,
  cycling: 7.5,
  swimming: 7.0,
  lifting: 5.0, // vigorous compound resistance training
  hiit: 8.0,
  crossfit: 8.0,
  rowing: 7.0,
  yoga: 3.0,
  pilates: 3.0,
  elliptical: 5.0,
  hiking: 6.0,
  basketball: 8.0,
  soccer: 7.0,
  tennis: 7.3,
  boxing: 9.0,
  dancing: 5.0,
  climbing: 8.0,
  sports: 7.0,
  cardio: 7.0,
};

// Baseline occupational / lifestyle PAL (TEE/BMR for NON-exercise living, which
// already folds in TEF and ordinary NEAT). Values sit inside the published bands:
//   [EEN] seated-no-moving 1.4-1.5; seated-with-moving 1.6-1.7; standing 1.8-1.9;
//         strenuous work 2.0-2.4.  [O2O] sedentary 1.0-1.4 ... very active 1.9-2.5.
export const OCCUPATION_PAL = {
  desk: 1.4,       // pure sitting; steps/exercise push this up
  student: 1.45,
  standing: 1.7,   // teacher, cashier, retail
  active_job: 1.85,// server, nurse, delivery
  labor: 2.05,     // construction, warehouse, mover, landscaping
};

// ----------------------------------------------------------------------------
// Natural-language activity parser
// ----------------------------------------------------------------------------

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2, few: 3, several: 4,
};

// Activity keyword -> canonical name. Order matters (specific before generic).
const ACTIVITY_PATTERNS = [
  { name: "lifting", re: /\b(lift|lifting|weights?|weight[- ]?training|resistance|strength[- ]?train\w*|barbell|dumbbell|bodybuild\w*|powerlift\w*)\b/ },
  { name: "hiit", re: /\b(hiit|interval training|intervals)\b/ },
  { name: "crossfit", re: /\bcrossfit\b/ },
  { name: "boxing", re: /\b(box|boxing|kickbox\w*|muay thai|sparring)\b/ },
  { name: "running", re: /\b(run|running|sprints?|sprinting)\b/ },
  { name: "jogging", re: /\b(jog|jogging)\b/ },
  { name: "cycling", re: /\b(cycl\w*|bike|biking|spin class|peloton)\b/ },
  { name: "swimming", re: /\b(swim|swimming|laps)\b/ },
  { name: "rowing", re: /\b(row|rowing|erg)\b/ },
  { name: "elliptical", re: /\belliptical\b/ },
  { name: "hiking", re: /\b(hike|hiking)\b/ },
  { name: "climbing", re: /\b(climb\w*|bouldering)\b/ },
  { name: "basketball", re: /\b(basketball|hoops)\b/ },
  { name: "soccer", re: /\b(soccer|footy)\b/ },
  { name: "tennis", re: /\b(tennis|pickleball|squash|racquetball)\b/ },
  { name: "yoga", re: /\byoga\b/ },
  { name: "pilates", re: /\bpilates\b/ },
  { name: "dancing", re: /\b(danc\w*)\b/ },
  { name: "walking", re: /\b(walk|walking|stroll\w*)\b/ },
  { name: "sports", re: /\b(sports?|pickup game|league|practice)\b/ },
  { name: "cardio", re: /\bcardio\b/ },
];

// Occupation keyword -> PAL key. Highest-PAL match wins (most demanding job).
const OCCUPATION_PATTERNS = [
  { key: "labor", re: /\b(construction|warehouse|mover|moving furniture|landscap\w*|farm\w*|roofer|manual labor|laborer|mason|carpenter|loading|warehousing|stocker)\b/ },
  { key: "active_job", re: /\b(mail carrier|postal|delivery|courier|waiter|waitress|server|barista|nurse|nursing|cook|chef|bartend\w*|housekeep\w*|warehouse)\b/ },
  { key: "standing", re: /\b(stand\w*|on my feet|teacher|teach\w*|cashier|retail|hairdress\w*|sales floor|host\w*|shop assistant)\b/ },
  { key: "student", re: /\b(student|college|university|campus|classes?)\b/ },
  { key: "desk", re: /\b(desk|office|sit all day|sitting all day|programmer|developer|software|engineer|accountant|cubicle|sedentary|analyst|writer|truck driver|drive all day|call center|remote work)\b/ },
];

function detectFrequencyPerWeek(clause) {
  if (/\bevery other day\b/.test(clause)) return 3.5;
  if (/\b(every ?day|daily|each day|7 ?days)\b/.test(clause)) return 7;
  if (/\bonce\b/.test(clause)) return 1;
  if (/\btwice\b/.test(clause)) return 2;
  if (/\bthrice\b/.test(clause)) return 3;
  // "4 days a week", "4x/week", "three times per week", "5 days/wk"
  const re = /(\d+|one|two|three|four|five|six|seven|eight|couple|few|several)\s*(?:x|times?|days?|sessions?|nights?|mornings?|evenings?)?\s*(?:per|a|each|\/)\s*(?:week|wk)/;
  const m = clause.match(re);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_NUM[m[1]];
    if (n) return clamp(n, 0.5, 14);
  }
  return null;
}

function detectMinutes(clause) {
  // hours: "an hour", "1 hour", "1.5 hours", "2 hrs", "half an hour"
  if (/\bhalf an hour\b/.test(clause)) return 30;
  let m = clause.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  if (/\b(an?|one)\s+hours?\b/.test(clause)) return 60;
  // minutes: "45 minutes", "30 min", "20min"
  m = clause.match(/(\d+)\s*(?:minutes?|mins?|min)\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function detectSteps(text) {
  // "5,000 steps", "10k steps", "8 thousand steps"
  const m = text.match(/([\d][\d,\.]*)\s*(k|thousand)?\s*steps?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (m[2]) n *= 1000;
  return Math.round(n);
}

/**
 * parseActivity(text, { weightKg }) -> structured, transparent estimate.
 * Everything it infers is returned so the UI can SHOW it and let the user correct
 * it — the honest answer to the "self-report is biased" problem is transparency.
 */
export function parseActivity(text, { weightKg = 75 } = {}) {
  // Strip thousands-separators ("5,000" -> "5000") FIRST, otherwise the comma in a
  // step count gets treated as a clause break and spawns a phantom walking session.
  const lower = (text || "").toLowerCase().replace(/(\d),(?=\d)/g, "$1");
  const notes = [];

  // --- occupation (whole-text, highest PAL wins) ---
  let occupation = null;
  for (const { key, re } of OCCUPATION_PATTERNS) {
    if (re.test(lower)) {
      if (!occupation || OCCUPATION_PAL[key] > OCCUPATION_PAL[occupation.key]) {
        occupation = { key, pal: OCCUPATION_PAL[key] };
      }
    }
  }
  if (!occupation) {
    occupation = { key: "desk", pal: OCCUPATION_PAL.desk, assumed: true };
    if (lower.trim()) notes.push("No clear occupation detected — assumed mostly seated (desk). Adjust if needed.");
  }

  // --- steps (NEAT) ---
  const steps = detectSteps(lower);

  // --- exercise sessions (per clause) ---
  const clauses = lower.split(/[,;.\n]|\band\b|\bbut\b|\balso\b|\bplus\b|\bthen\b/).map((c) => c.trim()).filter(Boolean);
  const sessions = [];
  for (const clause of clauses) {
    // A clause that is really about steps shouldn't also spawn a walking session.
    if (/steps?/.test(clause) && /\bwalk/.test(clause)) continue;
    let matched = null;
    for (const { name, re } of ACTIVITY_PATTERNS) {
      if (re.test(clause)) { matched = name; break; }
    }
    if (!matched) continue;
    // Don't treat the occupation clause ("work a desk job") as exercise.
    if (matched === "walking" && /\b(work|job|desk|office)\b/.test(clause) && !detectFrequencyPerWeek(clause)) continue;

    let days = detectFrequencyPerWeek(clause);
    let minutes = detectMinutes(clause);
    if (days == null) { days = 3; notes.push(`Assumed 3×/week for "${matched}" (no frequency stated).`); }
    if (minutes == null) { minutes = 45; notes.push(`Assumed 45 min/session for "${matched}" (no duration stated).`); }
    sessions.push({ activity: matched, met: MET_TABLE[matched], daysPerWeek: days, minutes });
  }

  // Hand the structured facts to the shared roll-up (same path the LLM parser uses).
  return buildActivityResult(
    { occupationKey: occupation.key, occupationAssumed: !!occupation.assumed, steps, sessions, notes },
    weightKg
  );
}

/**
 * Shared roll-up — the SINGLE place activity facts become calories. Used by both
 * the regex parser (above) and the LLM parser (server.mjs → app.js). The LLM only
 * supplies structure (occupation key, steps, sessions); this tested function does
 * every multiplication, so a model can never hand back an invented calorie number.
 *
 * sessions: [{ activity, daysPerWeek, minutes, met? }] — `met` is looked up from
 * MET_TABLE by activity name when absent (the LLM path doesn't send METs).
 */
export function buildActivityResult(
  { occupationKey = "desk", occupationAssumed = false, steps = null, sessions = [], notes = [] },
  weightKg
) {
  const key = OCCUPATION_PAL[occupationKey] != null ? occupationKey : "desk";
  const occupation = { key, pal: OCCUPATION_PAL[key], assumed: occupationAssumed };

  // Normalise + clamp sessions; fill MET from the table when the LLM omitted it.
  const normSessions = (sessions || [])
    .map((s) => ({
      activity: s.activity,
      met: Number.isFinite(s.met) ? s.met : (MET_TABLE[s.activity] ?? 6.0),
      daysPerWeek: clamp(Number(s.daysPerWeek) || 0, 0, 14),
      minutes: clamp(Number(s.minutes) || 0, 0, 360),
    }))
    .filter((s) => s.daysPerWeek > 0 && s.minutes > 0);

  const weeklyExerciseKcal = normSessions.reduce(
    (sum, s) => sum + metNetKcal(s.met, weightKg, s.minutes) * s.daysPerWeek, 0);
  const dailyExerciseKcal = weeklyExerciseKcal / 7;

  // Steps NEAT. Discount when the job is already on-its-feet (its PAL already
  // bakes in lots of ambulation), so we don't count those steps twice.
  let dailyStepsKcal = steps ? stepsNetKcal(steps, weightKg) : 0;
  const allNotes = [...(notes || [])];
  if (["standing", "active_job", "labor"].includes(key) && steps) {
    dailyStepsKcal *= 0.4;
    allNotes.push("Step calories discounted because your job already involves a lot of movement.");
  }

  return {
    occupation,
    steps: steps ?? null,
    sessions: normSessions,
    basePAL: occupation.pal,
    dailyExerciseKcal,
    dailyStepsKcal,
    notes: allNotes,
  };
}

// ----------------------------------------------------------------------------
// Plasma donation modifier  —  derived from blood/plasma biochemistry
// ----------------------------------------------------------------------------
//
//   [BLOOD-CAL]   Maynard, "Calories in Human Blood" (author: PhD nutritional
//                 biochemistry). Itemised calc: a 500 mL WHOLE-blood unit holds
//                 ~425 (women) to ~460 (men) kcal of caloric CONTENT, and notes the
//                 actual replacement cost is HIGHER because synthesis is inefficient.
//   [PLASMA-PHYS] StatPearls, Physiology Blood Plasma: plasma is 91-92% water,
//                 8-9% solids; in plasmapheresis the cells are returned to the donor.
//   [PLASMA-CONST] Deranged Physiology: plasma protein ~70-90 g/L (~80% albumin).
//   [CUIMC]       Columbia/NYP (Dr. Vossoughi, apheresis director): "it takes your
//                 body about 500 calories to replace" one whole-blood donation.
//   [UCSD]        Medical Daily citing UC San Diego: "~650 kcal per pint."
//
/*
 * PLASMA DONATION ENERGY COST — this is now derived, not guessed.
 *
 * Earlier this file dismissed the popular "450-650 kcal" figure as inflated. That was
 * wrong, and the correction matters. The number comes from real biochemistry, and the
 * key was separating TWO things the popular figures conflate:
 *
 *   (A) Caloric CONTENT removed  — the energy in the protein/fat/sugar that physically
 *       leaves in the bag. Protein ~4 kcal/g, fat ~9, sugar ~4 [BLOOD-CAL].
 *   (B) Synthesis COST to rebuild it — ATP burned resynthesising the lost protein,
 *       ~2.2 kcal per gram turned over (established biochemical estimate). This is the
 *       "replacement total would be higher" point [BLOOD-CAL].
 *
 * For a *maintenance* calculator (how much to eat to stay weight- AND protein-stable)
 * the right figure is (A)+(B): you must both replace the exported mass and power its
 * synthesis. Strictly, only (B) is heat "expended"; (A) is a replacement requirement.
 * The UI lets you choose, and shows the split.
 *
 * WHOLE BLOOD vs PLASMA — the crucial distinction the sources expose:
 *   - The famous 500 [CUIMC] / 650 [UCSD] figures are for WHOLE BLOOD (one pint). Most
 *     of that is hemoglobin from the red cells [BLOOD-CAL].
 *   - PLASMA donation RETURNS the red cells [PLASMA-PHYS], so NO hemoglobin is lost —
 *     only plasma constituents. But plasma donors give more volume (690-880 mL, larger
 *     for heavier donors) far more often. Working the numbers for plasma specifically
 *     gives ~355-455 kcal/session — below whole blood's 650 (no hemoglobin) but well
 *     above a synthesis-only estimate.
 *
 * Bigger donors land higher because FDA volume tiers collect more plasma from heavier
 * people -> more protein -> more kcal. We model that directly via volume(weight).
 */

// Defaults are mid-range, sourced values; all are overridable for transparency.
const PLASMA_DEFAULTS = {
  proteinGPerL: 75,   // [PLASMA-CONST] 70-90 g/L; 75 is a conservative midpoint
  fatGPerL: 5,        // [BLOOD-CAL] 0.5 g/100 mL triglycerides + fatty acids
  sugarGPerL: 1,      // [BLOOD-CAL] ~0.9 g/L plasma glucose
  proteinKcalPerG: 4, // Atwater
  fatKcalPerG: 9,
  sugarKcalPerG: 4,
  synthKcalPerG: 2.2, // ATP cost of protein synthesis/turnover
  volLoL: 0.69,       // collected plasma volume at the light end (~690 mL)
  volHiL: 0.88,       // at the heavy end (~880 mL)
  wLoKg: 50,
  wHiKg: 115,
};

/**
 * Full per-session breakdown for a PLASMA donation, derived from body weight.
 * Returns { volumeMl, proteinG, contentKcal, synthKcal, total }.
 */
export function plasmaBiochem(weightKg, opts = {}) {
  const p = { ...PLASMA_DEFAULTS, ...opts };
  const t = clamp((weightKg - p.wLoKg) / (p.wHiKg - p.wLoKg), 0, 1);
  const volumeL = p.volLoL + t * (p.volHiL - p.volLoL);
  const proteinG = volumeL * p.proteinGPerL;
  const fatG = volumeL * p.fatGPerL;
  const sugarG = volumeL * p.sugarGPerL;
  const contentKcal = proteinG * p.proteinKcalPerG + fatG * p.fatKcalPerG + sugarG * p.sugarKcalPerG;
  const synthKcal = proteinG * p.synthKcalPerG;
  return {
    volumeMl: Math.round(volumeL * 1000),
    proteinG: round(proteinG, 1),
    contentKcal: Math.round(contentKcal),
    synthKcal: Math.round(synthKcal),
    total: Math.round(contentKcal + synthKcal),
  };
}

/**
 * Per-session kcal. Default = caloric content + synthesis (replacement cost, the
 * right figure for a maintenance target). strictExpenditureOnly = synthesis ATP only.
 */
export function plasmaKcalPerSession(weightKg, { strictExpenditureOnly = false, ...opts } = {}) {
  const b = plasmaBiochem(weightKg, opts);
  return strictExpenditureOnly ? b.synthKcal : b.total;
}

/** Daily kcal added to TDEE = per-session * sessions/week / 7. */
export function plasmaDailyKcal({ weightKg, sessionsPerWeek, kcalPerSession, strictExpenditureOnly = false }) {
  const per = kcalPerSession != null ? kcalPerSession : plasmaKcalPerSession(weightKg, { strictExpenditureOnly });
  return (per * sessionsPerWeek) / 7;
}

// ----------------------------------------------------------------------------
// Metabolic adaptation modifier  [TRX], [O2O], [PMT]
// ----------------------------------------------------------------------------

/*
 * Adaptive thermogenesis: after a PROLONGED deficit (>8 wk), TDEE falls by MORE than
 * tissue loss alone predicts — BMR, NEAT, TEF and even the cost of exercise all drop,
 * and the suppression persists after weight stabilises [TRX]. [O2O] notes very-low-cal
 * diets slow metabolism; [PMT] notes calculators wrongly assume metabolism is static.
 * Conversely a prolonged surplus nudges expenditure UP (refeed/overfeed raised TDEE
 * ~7% acutely in [TRX]). [TRX] stresses the magnitude is PROPORTIONAL to deficit size,
 * so we expose a strength control and keep all values deliberately modest.
 */
export const ADAPTATION_PRESETS = {
  none: 0,
  deficit_mild: -0.03,
  deficit_moderate: -0.05,
  deficit_aggressive: -0.08,
  surplus: 0.03,
};

export function adaptationFactor(mode = "none", strengthPct = null) {
  if (strengthPct != null) return 1 + strengthPct / 100;
  return 1 + (ADAPTATION_PRESETS[mode] ?? 0);
}

// ----------------------------------------------------------------------------
// Goal projections  [CM]
// ----------------------------------------------------------------------------

/** Time to reach a target weight at a fixed daily calorie offset (7700 kcal/kg). */
export function timeToGoal({ currentKg, targetKg, dailyDeltaKcal }) {
  const totalKg = Math.abs(targetKg - currentKg);
  const kgPerDay = Math.abs(dailyDeltaKcal) / KCAL_PER_KG;
  const days = kgPerDay > 0 ? totalKg / kgPerDay : Infinity;
  return { days, weeks: days / 7, kgPerDay };
}

// ----------------------------------------------------------------------------
// BMI  (WHO classification)
// ----------------------------------------------------------------------------
export function bmi(weightKg, heightCm) {
  const m = heightCm / 100;
  return m > 0 ? weightKg / (m * m) : NaN;
}
export function bmiCategory(b) {
  if (!Number.isFinite(b)) return { key: "na", label: "—" };
  if (b < 18.5) return { key: "under", label: "Underweight" };
  if (b < 25) return { key: "normal", label: "Healthy weight" };
  if (b < 30) return { key: "over", label: "Overweight" };
  if (b < 35) return { key: "ob1", label: "Obese (class I)" };
  if (b < 40) return { key: "ob2", label: "Obese (class II)" };
  return { key: "ob3", label: "Obese (class III)" };
}

// ----------------------------------------------------------------------------
// Diet planning — cut / maintain / bulk macros
//
//   Protein  [SBS]  Nuckols, "Protein Science Updated" — scale to FAT-FREE MASS when
//                   known (preferred): ~2.35 g/kg FFM to maintain/gain. By bodyweight:
//                   men ~2.0, women ~1.75 g/kg. Dieting needs more: ≥2.5 g/kg FFM (or
//                   ≥2.0 g/kg BW) up to 4.0 g/kg FFM (3.0 g/kg BW) to preserve/gain
//                   lean mass — benefits larger for leaner people. Corroborated by
//                   [Roberts/Helms 2020] (1.8-2.7, up to 3.5 g/kg) and the cut paper.
//   Fat      [Helms/Roberts 2020]  15-25% of calories, a bit LOWER on a cut so the
//                   remaining "energy budget" can go to carbs for training. Floor at
//                   ~0.5 g/kg bodyweight for hormones / essential fatty acids.
//   Carbs    [Escobar 2017 / Roberts 2020]  the REMAINDER. Resistance trainees don't
//                   need the endurance-style 4-7 g/kg; 2-5 g/kg is realistic, and carbs
//                   should flex with the calorie target.
// ----------------------------------------------------------------------------
export const KCAL = { protein: 4, carb: 4, fat: 9 }; // Atwater
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);

/** Weekly weight change implied by a daily calorie offset (7700 kcal/kg). */
export function weightChangeKgPerWeek(offsetKcal) {
  return (offsetKcal * 7) / KCAL_PER_KG;
}

export function dietGoal(offsetKcal) {
  if (offsetKcal <= -50) return "cut";
  if (offsetKcal >= 50) return "bulk";
  return "maintain";
}

/**
 * Research-based weekly-rate zone for the diet slider.
 * Loss: 0.5-1%/week preserves muscle best (Healthline/Helms); faster than ~1%/week is
 * the "danger zone" — muscle loss + metabolic adaptation scale with deficit size (Trexler).
 * Gain: 0.25-0.5%/week is a lean bulk; faster adds disproportionate fat (Healthline).
 * tone: neutral | ok | caution | danger.
 */
export function dietZone({ offsetKcal, weightKg }) {
  const kgPerWeek = weightChangeKgPerWeek(offsetKcal);
  const pctPerWeek = weightKg > 0 ? (Math.abs(kgPerWeek) / weightKg) * 100 : 0;
  const goal = dietGoal(offsetKcal);
  let label, tone;
  if (goal === "maintain") { label = "Maintenance"; tone = "neutral"; }
  else if (goal === "cut") {
    if (pctPerWeek > 1.0) { label = "Aggressive cut — danger zone"; tone = "danger"; }
    else if (pctPerWeek >= 0.5) { label = "Recommended cut"; tone = "ok"; }
    else { label = "Gentle cut"; tone = "ok"; }
  } else {
    if (pctPerWeek > 0.5) { label = "Fast bulk — more fat gain"; tone = "caution"; }
    else if (pctPerWeek >= 0.25) { label = "Lean bulk"; tone = "ok"; }
    else { label = "Slow bulk"; tone = "ok"; }
  }
  return { goal, kgPerWeek, pctPerWeek, label, tone };
}

/**
 * Macro split for a calorie target = TDEE + offsetKcal. Protein first (SBS), then fat
 * (Helms %, hormonal floor), then carbs as the remainder ("energy budget").
 */
export function macroTargets({ tdee, offsetKcal, weightKg, leanMassKg = null, sex = "male" }) {
  const calories = Math.max(0, tdee + offsetKcal);
  const goal = dietGoal(offsetKcal);
  const deficitFraction = offsetKcal < 0 ? clamp(-offsetKcal / 1000, 0, 1) : 0;

  // --- protein (SBS; scale to FFM when body composition is known — SBS-preferred) ---
  const usingFFM = leanMassKg != null && leanMassKg > 0;
  let proteinGPerKgRef;
  if (usingFFM) {
    proteinGPerKgRef = goal === "cut" ? lerp(2.5, 4.0, deficitFraction) : 2.35;
  } else {
    const base = goal === "cut" ? lerp(2.0, 3.0, deficitFraction) : 2.0;
    proteinGPerKgRef = sex === "female" ? base * 0.875 : base; // women ~12.5% less FFM/BW
  }
  const refMass = usingFFM ? leanMassKg : weightKg;
  const proteinG = proteinGPerKgRef * refMass;
  const proteinKcal = proteinG * KCAL.protein;

  // --- fat (Helms: 15-25% cal, lower on a cut; floor ~0.5 g/kg BW for hormones) ---
  const fatPct = goal === "cut" ? 0.22 : goal === "bulk" ? 0.28 : 0.25;
  const fatFloorG = 0.5 * weightKg;
  let fatG = Math.max((calories * fatPct) / KCAL.fat, fatFloorG);
  let fatKcal = fatG * KCAL.fat;

  // --- carbs = remainder ---
  let carbKcal = calories - proteinKcal - fatKcal;
  let note = null;
  if (carbKcal < 0) {
    fatG = fatFloorG; fatKcal = fatG * KCAL.fat;          // drop fat to the floor first
    carbKcal = calories - proteinKcal - fatKcal;
    if (carbKcal < 0) { carbKcal = 0; note = "This calorie target is below your protein + essential-fat needs — the deficit is too aggressive."; }
    else { note = "Fat set to the hormonal floor (0.5 g/kg) so protein fits this aggressive deficit."; }
  }
  const carbG = carbKcal / KCAL.carb;

  const mk = (g, kcal) => ({
    g: Math.round(g), kcal: Math.round(kcal),
    pct: calories > 0 ? Math.round((kcal / calories) * 100) : 0,
    gPerKg: round(g / weightKg, 2),
  });
  return {
    calories: Math.round(calories),
    goal,
    protein: { ...mk(proteinG, proteinKcal), gPerKgRef: round(proteinGPerKgRef, 2), refIsFFM: usingFFM },
    fat: mk(fatG, fatKcal),
    carb: mk(carbG, carbKcal),
    note,
  };
}

// ----------------------------------------------------------------------------
// Top-level assembly
// ----------------------------------------------------------------------------

/**
 * computeTDEE — ties everything together and returns a fully transparent breakdown.
 *
 * Pipeline:
 *   BMR  (Katch-McArdle if BF% given, else Mifflin-St Jeor)
 *     -> * occupational PAL                          (base non-exercise living)
 *     -> + exercise kcal (net METs)                  (parsed sessions)
 *     -> + steps kcal (net)                          (parsed NEAT)
 *     -> + plasma kcal (weekly-averaged)             (optional)
 *     -> * adaptation factor                         (optional)
 */
export function computeTDEE(input) {
  const {
    sex, age, weightKg, heightCm,
    bodyFatFraction = null,
    activityText = "",
    parse: providedParse = null,
    manualBasePAL = null,
    plasma = { enabled: false },
    adaptation = { mode: "none" },
  } = input;

  // --- 1. resting metabolism ---
  const mifflin = mifflinStJeor({ weightKg, heightCm, age, sex });
  let leanMassKg = null, katch = null, ffm = null, pontzer = null;
  if (bodyFatFraction != null) {
    leanMassKg = leanBodyMass({ weightKg, bodyFatFraction });
    katch = katchMcArdle({ leanBodyMassKg: leanMassKg }) * ageFactorOver60(age);
    ffm = ffmRee({ fatFreeMassKg: leanMassKg }) * ageFactorOver60(age);
    pontzer = pontzerTEE({ fatFreeMassKg: leanMassKg });
  }
  const usingKatch = bodyFatFraction != null;
  const bmr = usingKatch ? katch : mifflin;
  const bmrMethod = usingKatch ? "Katch-McArdle (lean-mass based)" : "Mifflin-St Jeor";

  // --- 2. activity ---
  const parse = providedParse || parseActivity(activityText, { weightKg });
  const basePAL = manualBasePAL != null ? manualBasePAL : parse.basePAL;
  const baseTDEE = bmr * basePAL;
  const exerciseKcalDaily = parse.dailyExerciseKcal || 0;
  const stepsKcalDaily = parse.dailyStepsKcal || 0;

  // --- 3. plasma ---
  let plasmaKcalDaily = 0;
  if (plasma && plasma.enabled && plasma.sessionsPerWeek > 0) {
    plasmaKcalDaily = plasmaDailyKcal({
      weightKg,
      sessionsPerWeek: plasma.sessionsPerWeek,
      kcalPerSession: plasma.kcalPerSession ?? null,
      strictExpenditureOnly: plasma.strictExpenditureOnly ?? false,
    });
  }

  // --- 4. adaptation ---
  const adaptFactor = adaptationFactor(adaptation.mode, adaptation.strengthPct ?? null);

  const preAdaptTDEE = baseTDEE + exerciseKcalDaily + stepsKcalDaily + plasmaKcalDaily;
  const tdee = preAdaptTDEE * adaptFactor;
  const effectivePAL = tdee / bmr;

  return {
    bmr: round(bmr),
    bmrMethod,
    leanMassKg: leanMassKg != null ? round(leanMassKg, 1) : null,
    alternatives: {
      mifflin: round(mifflin),
      katchMcArdle: katch != null ? round(katch) : null,
      ffmEquation: ffm != null ? round(ffm) : null,
    },
    pontzerCrossCheck: pontzer != null ? round(pontzer) : null,
    parse,
    basePAL: round(basePAL, 2),
    baseTDEE: round(baseTDEE),
    exerciseKcalDaily: round(exerciseKcalDaily),
    stepsKcalDaily: round(stepsKcalDaily),
    plasmaKcalDaily: round(plasmaKcalDaily),
    adaptationFactor: adaptFactor,
    preAdaptTDEE: round(preAdaptTDEE),
    tdee: round(tdee),
    effectivePAL: round(effectivePAL, 2),
    rangeLow: round(tdee * (1 - UNCERTAINTY_BAND)),
    rangeHigh: round(tdee * (1 + UNCERTAINTY_BAND)),
  };
}
