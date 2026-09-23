// =====================================================================
// Edge Function: ai-tutor   (Member 3 — Socratic, age/level-adaptive AI Tutor)
//
// The LLM key lives ONLY here (never in the browser). Pick ONE free or paid provider:
//   supabase secrets set GROQ_API_KEY=<gsk_...>        (free, console.groq.com/keys)   <- default choice
//   supabase secrets set GEMINI_API_KEY=<AIza...>      (free, aistudio.google.com/apikey)
//   supabase secrets set ANTHROPIC_API_KEY=<sk-ant-..> (paid)
// Optional: AI_PROVIDER=groq|gemini|anthropic (if several keys are set), AI_MODEL=<model id>.
// Deploy:  supabase functions deploy ai-tutor
// Call:    POST /functions/v1/ai-tutor   (Authorization: Bearer <user token>)
//          { "message": "...", "history": [{role:"user"|"assistant", content:"..."}], "mode": "socratic"|"explain" }
// Returns: { reply, mode, auto_escalated, grounded_on: [evidence_id, ...] }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS, json, loadStudentEvidence, resolveStudent } from "../_shared/xai/evidence.ts";
import { callLLM, type Msg, pickProvider } from "../_shared/agent/llm.ts";

function styleFor(age: string | null, level: string | null): string {
  const lv = level ? ` (education level: ${level})` : "";
  switch (age) {
    case "6-10":
      return `The student is 6-10 years old${lv}. Use very short sentences, everyday words and playful real-life examples. No jargon.`;
    case "11-14":
      return `The student is 11-14 years old${lv}. Use simple vocabulary, concrete examples and friendly encouragement. Define any technical term.`;
    case "15-18":
      return `The student is 15-18 years old${lv}. Use clear, precise language and exam-relevant examples. Introduce technical terms with a short definition.`;
    default:
      return `The student is an adult learner${lv}. Be concise and technically accurate; use professional terminology and real-world applications.`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const provider = pickProvider();
    if (!provider) return json({ error: "AI Tutor is not configured: set one of the GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY secrets." }, 503);

    const who = await resolveStudent(req, createClient);
    if ("error" in who) return json({ error: who.error }, who.status);

    const body = await req.json().catch(() => ({}));
    const message = String(body.message ?? "").trim().slice(0, 1500);
    if (!message) return json({ error: "message is required" }, 400);
    const requestedMode = body.mode === "explain" ? "explain" : "socratic";
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m: { role?: string; content?: string }) =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content.slice(0, 1500) }));

    // Agentic mode-switch: the tutor's own hint history is the evidence here — no extra
    // storage needed, since the frontend already resends it every turn. If the student is
    // still going after 2 Socratic hints, keep guiding once more is diminishing returns;
    // auto-escalate to a full explanation rather than waiting for a manual toggle.
    const priorHintTurns = history.filter((m: Msg) => m.role === "assistant").length;
    const autoEscalated = requestedMode === "socratic" && priorHintTurns >= 2;
    const mode = autoEscalated ? "explain" : requestedMode;

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [ev, profileRes, goalsRes, recsRes] = await Promise.all([
      loadStudentEvidence(admin, who.studentId),
      admin.from("profiles").select("full_name,age_group,education_level,language,goals").eq("id", who.studentId).maybeSingle(),
      admin.from("learning_goals").select("goal").eq("student_id", who.studentId).limit(3),
      admin.from("recommendations").select("recommended_topic,reason").eq("student_id", who.studentId)
        .order("created_at", { ascending: false }).limit(3),
    ]);
    const p = profileRes.data ?? {};
    const goals = [...(p.goals ?? []), ...((goalsRes.data ?? []).map((g: { goal: string }) => g.goal))];

    const evidenceLines = ev.evidence
      .map((e) => {
        // deno-lint-ignore no-unused-vars
        const { evidence_id, supporting_attempt_ids, ...rest } = e;
        return `- [${evidence_id}] ${JSON.stringify(rest)}`;
      })
      .join("\n");
    const recs = (recsRes.data ?? []) as { recommended_topic: string; reason: string }[];

    const system = [
      "You are StudyPilot's AI Tutor.",
      styleFor(p.age_group ?? null, p.education_level ?? null),
      p.language && p.language !== "en"
        ? `Reply in the student's language (code: ${p.language}) unless they write in another.` : "",
      mode === "socratic"
        ? "SOCRATIC MODE: do not hand over the final answer straight away. Guide with one short question or hint at a time, let the student attempt each step, confirm what is right, and gently correct what is wrong. Only give the full solution if the student explicitly asks after trying, or is clearly stuck after two hints."
        : "EXPLAIN MODE: give a clear step-by-step explanation with one worked example, then ask one short question to check understanding.",
      autoEscalated
        ? "The student has had two hint turns already without resolving this, so this reply switched to EXPLAIN MODE automatically. Acknowledge their effort in one short clause, then explain plainly — do not keep hinting."
        : "",
      "Keep replies under 150 words. Never reveal quiz answer keys or claim to have seen questions you have not been shown.",
      "PERSONALISATION: use ONLY the evidence below when talking about the student's performance. Never invent scores, counts or trends. If asked about performance the evidence does not cover, say you do not have that data yet.",
      goals.length ? `Student goals: ${goals.join("; ")}.` : "",
      `Overall accuracy ${ev.summary.overall_accuracy}%, trend ${ev.summary.accuracy_trend}, weakest concept: ${ev.summary.weakest_concept ?? "none yet"}.`,
      "EVIDENCE:\n" + (evidenceLines || "(no quiz data yet)"),
      recs.length ? "CURRENT RECOMMENDATIONS:\n" + recs.map((r) => `- ${r.recommended_topic}: ${r.reason}`).join("\n") : "",
      "If the student's question relates to a weak concept in the evidence, tailor the help to it and briefly say why (e.g. \"your Loops accuracy is 40%\").",
    ].filter(Boolean).join("\n\n");

    let reply: string;
    try {
      reply = await callLLM(provider, system, [...history, { role: "user", content: message }] as Msg[]);
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
    if (!reply) return json({ error: "The AI returned an empty answer. Please try again." }, 502);
    return json({ reply, mode, auto_escalated: autoEscalated, grounded_on: ev.evidence.map((e) => e.evidence_id) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
