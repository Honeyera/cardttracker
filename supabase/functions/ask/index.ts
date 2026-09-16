import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // Require a logged-in user (only household members should use this).
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return json({ error: "Invalid or expired session" }, 401);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "AI is not configured (missing ANTHROPIC_API_KEY secret)" }, 500);

    const { question, context } = await req.json();
    if (!question || typeof question !== "string" || question.length > 2000) {
      return json({ error: "Invalid question" }, 400);
    }

    const system =
      "You are a financial assistant for a personal/business finance dashboard. " +
      "Answer the user's question using ONLY the JSON data provided (their bank accounts, credit cards, and recent transactions). " +
      "Rules: all amounts are USD; be concise and direct; when listing transactions include the date, description, amount, and which card/account; " +
      "credit-card 'income'/'refund' are money back, not revenue; 'payment' rows are card payments. " +
      "If the provided data does not contain enough information to answer (e.g. the question needs older history than what's included), say so plainly rather than guessing. " +
      "Do not invent numbers.";

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1024,
        output_config: { effort: "low" },
        system,
        messages: [
          {
            role: "user",
            content: `DATA:\n${JSON.stringify(context).slice(0, 180000)}\n\nQUESTION: ${question}`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text();
      console.error("Anthropic error", anthropicRes.status, detail.slice(0, 500));
      if (anthropicRes.status === 429) return json({ error: "Rate limited — try again shortly." }, 429);
      return json({ error: `AI request failed (${anthropicRes.status})` }, 502);
    }

    const data = await anthropicRes.json();
    const answer = (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    return json({ answer: answer || "No answer returned." });
  } catch (error) {
    console.error("ask error:", error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
