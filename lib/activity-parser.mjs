/*
 * activity-parser.mjs — the free-text week parser, shared by both hosts.
 *
 * server.mjs (Render / local) and api/parse-activity.js (Vercel) both import this,
 * so the prompt and schema have exactly one definition. The allowed activity and
 * occupation values are read from calc.js, so the model can only ever emit keys the
 * calculation engine knows how to price.
 *
 * This module never computes calories. It returns structure; calc.js does the maths.
 */
import { MET_TABLE, OCCUPATION_PAL } from "../calc.js";

const ACTIVITIES = Object.keys(MET_TABLE);
const OCCUPATIONS = Object.keys(OCCUPATION_PAL);

export const MAX_TOKENS = 300;

export const SYSTEM_PROMPT = `You extract a structured weekly-activity profile from a free-text description for a TDEE (energy expenditure) calculator. You do NOT compute calories — downstream code does that. Return only the structured fields.

OCCUPATION — choose the single key that best matches the person's typical work/day:
- "desk": mostly seated (office, programming, driving a desk job, remote work, a student who mostly sits, writer, analyst).
- "student": general student/campus life with meaningful walking between classes.
- "standing": on their feet much of the day (teacher, cashier, retail, host, bartender-lite).
- "active_job": continuous moving (nurse, server/waiter, delivery, housekeeping, light warehouse).
- "labor": heavy physical work (construction, mover, landscaping, farm, roofing).
Pick the most physically demanding role that genuinely fits. If unclear, use "desk" and add a note.

STEPS — integer daily step count if stated ("5,000 steps", "10k") else 0. Convert "10k" to 10000. If steps are given per week, divide to a daily figure and note it.

SESSIONS — one entry per distinct intentional workout. Map each to the closest activity key from this list: ${ACTIVITIES.join(", ")}.
- daysPerWeek: how many days per week (use 3.5 for "every other day", 7 for "daily").
- minutes: minutes per session.
- If frequency or duration is missing, estimate sensibly (default 3 days/week, 45 min) and add a note naming the assumption.
- Do NOT create a session for plain step-count walking (that's captured by STEPS). Do create one for deliberate "I walk 30 min for exercise" type entries.
- Two-a-days or split routines: sum into realistic per-week totals.

NOTES — short strings flagging any assumption or ambiguity you resolved. Empty array if everything was explicit.`;

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    occupation: {
      type: "object", additionalProperties: false,
      properties: { key: { type: "string", enum: OCCUPATIONS } }, required: ["key"],
    },
    steps: { type: "integer" }, // 0 = none stated
    sessions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          activity: { type: "string", enum: ACTIVITIES },
          daysPerWeek: { type: "number" },
          minutes: { type: "integer" },
        },
        required: ["activity", "daysPerWeek", "minutes"],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["occupation", "steps", "sessions", "notes"],
};

/**
 * @param client  an Anthropic SDK client
 * @param model   model id
 * @returns the structured profile; throws on any provider or parse failure, which
 *          both callers collapse into { ok:false, error:"provider_unavailable" }.
 */
export async function parseActivityLLM(client, model, text, weightKg) {
  // Haiku 4.5: structured outputs only — no `effort`/`thinking` (those error on Haiku).
  const resp = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: `Body weight: ${weightKg} kg.\n\nDescribe-your-week text:\n"""${text}"""`,
    }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const data = JSON.parse(block.text); // structured output → valid JSON (throws → caught → fallback)
  return {
    occupationKey: data.occupation?.key ?? "desk",
    steps: data.steps && data.steps > 0 ? data.steps : null,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}
