# Adaptive TDEE Calculator

A research-grounded Total Daily Energy Expenditure calculator that corrects for the
flaws in standard calculators: population-average equations, vague activity buttons,
inflated exercise burn, ignored NEAT, and the assumption that metabolism is static.

## Run it

**Static (no AI, zero setup):**

```bash
python3 -m http.server 4173 --directory .   # then open http://localhost:4173
```

Plain HTML/CSS/ES-modules. The keyword activity parser runs entirely in the browser.

**With the LLM activity parser (optional):**

```bash
npm install                                  # installs @anthropic-ai/sdk (once)
ANTHROPIC_API_KEY=sk-ant-... npm start       # node server.mjs, serves on :4174
# then open http://localhost:4174 and click "Understand with AI"
```

The Node server serves the same static app **and** exposes `POST /api/parse-activity`,
which sends your free-text week to Claude (`claude-haiku-4-5`, the cheapest available
model) and returns a structured profile. **Without a key the endpoint returns 503 and the
browser silently falls back to the offline keyword parser** — the app never breaks. The
API key lives only in the server's environment; it is never sent to the browser.

> Production hardening (`server.mjs`): cheapest model with `max_tokens` capped at 300, a
> 5-requests-per-minute-per-IP rate limit, and a 5 KB request-body cap. Any provider error
> returns `{ ok: false, error: "provider_unavailable" }` and the browser drops to the local
> parser. Override the model with the `ANTHROPIC_MODEL` env var.

## Verify the maths

```bash
node calc.test.mjs     # 86 assertions, all tied to the source documents
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI + the "Research & Pitfalls" section with inline citations |
| `styles.css` | Responsive light/dark theme |
| `app.js` | UI glue — reads inputs, calls the engine, paints results live |
| `calc.js` | **Pure, tested calculation engine.** All formulas + source tags live here |
| `server.mjs` | Optional Node server: static files + Claude-backed `/api/parse-activity` |
| `calc.test.mjs` | Node verification harness (run with `node calc.test.mjs`) |
| `sources/` | Bundled copies of the provided-only source documents, linked from the citations |

## BMI + diet & macro planner

- **BMI** is auto-calculated and shown unobtrusively in the results panel, with its shortfalls
  (can't tell muscle from fat) spelled out in the Research section.
- **Diet planner**: a slider from a **1,000 kcal cut (red danger zone)** to a 1,000 kcal bulk builds a
  macro split from the *exact* TDEE. **Protein** follows Stronger By Science (≈2.0 g/kg bodyweight, or
  2.35 g/kg lean mass when body-fat % is entered; ramped to ≈3.0 g/kg on aggressive cuts). **Fat** is
  15–25% of calories with a 0.5 g/kg hormonal floor (Helms/Roberts 2020). **Carbs** take the remainder
  (Escobar 2017 — resistance trainees don't need endurance-style carb loads). The danger coloring is
  rate-based: 0.5–1%/week preserves muscle best, faster is flagged.
- **Every citation is a clickable link** — published works to their canonical URL, provided-only docs to
  the bundled `sources/` copies.

## How the LLM parser stays honest

The model **only extracts structure** — `{ occupation, steps, sessions:[{activity, days/week, minutes}] }`,
constrained by a JSON schema whose allowed values come straight from `calc.js`. The browser
then feeds that structure to `buildActivityResult()` — the same tested function the keyword
parser uses — which does every calorie multiplication. So the model never returns a calorie
number; the math stays deterministic and auditable, and the LLM and keyword paths are proven
to produce identical numbers (test §12b).

## What it does differently

- **Lean mass first.** Enter body-fat % and it switches from Mifflin-St Jeor to the
  lean-mass **Katch-McArdle** equation, cross-checked against the FFM equation
  (23.9·FFM + 372) and Pontzer's 2021 FFM power law.
- **Plain-English activity.** A `<textarea>` parser pulls your job, your steps, and
  each workout (type / frequency / duration) out of free text and converts them to
  calories via METs — instead of a vague "moderately active" dropdown. It shows its
  work so you can correct it.
- **NEAT-aware.** Step count moves the number; the honest range stays wide.
- **Metabolic adaptation.** A prolonged-deficit/surplus selector applies a modest,
  Trexler-2014-grounded adjustment.
- **Honest uncertainty.** Shows a ±12% band and explains the >±20% residual variation
  Pontzer found even after controlling for body composition.
- **Auto BMI** in the results panel (with caveats spelled out in the Pitfalls section —
  it can't tell muscle from fat).
- **Diet & macro planner.** A cut↔bulk slider (−1000 to +1000 kcal, red danger zone on
  the deep-deficit end) that builds a macro split from your *exact* TDEE: **protein per
  Stronger By Science** (FFM-scaled when body-fat % is known, ramped up on a cut), **fat
  15–25% with a hormonal floor (Helms 2020)**, **carbs as the remainder (Escobar 2017)**.
  A live badge flags your personal weekly rate against the research-backed 0.5–1%/week band.

## Two deliberate honesty notes

1. **Plasma donation** is *derived from blood/plasma biochemistry*, not guessed. A
   session keeps ~690–880 mL of plasma (weight-scaled), removing ~50–66 g of protein.
   The default counts its caloric content (~4 kcal/g) **plus** the synthesis cost to
   rebuild it (~2.2 kcal/g) — the "replacement" figure (~355–455 kcal) appropriate for
   a maintenance target, with a transparent per-session breakdown in the UI. The popular
   500–650 figures (Columbia, UC San Diego) are for *whole blood*, most of which is
   hemoglobin you keep when giving plasma. A "strict expenditure" toggle counts only the
   synthesis cost (~130 kcal); the slider lets you tune for hydration/diet/protein level.
2. **Self-report is biased.** Parsing makes the estimate granular and transparent, not
   accurate. Treat the output as a hypothesis to test against two weeks of weigh-ins.

## Sources

Mifflin/Harris-Benedict comparison and PAL tables (*Estimating Energy Needs*);
Katch-McArdle, NEAT, exercise overestimation (*Problems with Modern TDEE*); FFM↔REE
and age decline (*one2one REE*); FFM power law and life-course variation
(Pontzer et al., *Science* 2021); adaptive thermogenesis (Trexler et al., *JISSN* 2014);
MET and goal-projection maths (*Computational Methods with MET*). Plasma biochemistry:
*Physiology, Blood Plasma* (StatPearls), *Constituents of plasma* (Deranged Physiology),
*Calories in Human Blood* (Maynard), Columbia/NYP and UC San Diego donation figures.
Macros: protein (*Protein Science Updated*, Stronger By Science / Nuckols); fat + protein
(*Nutritional Recommendations for Physique Athletes*, Roberts/Helms/Trexler/Fitschen 2020);
carbohydrate need (Escobar et al., *Br J Nutr* 2017); cut/bulk rates (*Bulking vs. Cutting*,
Healthline); nutrient timing (ISSN position stand).

*Educational tool, not medical advice.*
