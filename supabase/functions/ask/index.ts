import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
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
    if (!question || typeof question !== "string" || question.length > 2000) return json({ error: "Invalid question" }, 400);

    // Card/account name maps for labeling results (queried once, RLS-scoped).
    const [{ data: cards }, { data: accounts }] = await Promise.all([
      supabase.from("credit_cards").select("id,name,last_four,company_name"),
      supabase.from("accounts").select("id,name,last_four,account_type"),
    ]);
    const cardById = new Map((cards ?? []).map((c: any) => [c.id, c]));
    const acctById = new Map((accounts ?? []).map((a: any) => [a.id, a]));
    const sourceName = (t: any) =>
      (t.credit_card_id && cardById.get(t.credit_card_id)?.name) ||
      (t.account_id && acctById.get(t.account_id)?.name) || null;

    // ── Tool the model can call to search/aggregate the FULL history ──────
    async function runQuery(args: any) {
      let q = supabase.from("transactions")
        .select("transaction_date,description,merchant_name,amount,transaction_type,category,credit_card_id,account_id");
      if (args.start_date) q = q.gte("transaction_date", args.start_date);
      if (args.end_date) q = q.lte("transaction_date", args.end_date);
      if (args.transaction_type) q = q.eq("transaction_type", args.transaction_type);
      if (args.description_contains) {
        // Accept comma-separated terms — matched as OR across description + merchant.
        const terms = String(args.description_contains).split(",").map((x) => x.trim().replace(/[%,]/g, "")).filter(Boolean);
        const ors = terms.flatMap((t) => [`description.ilike.%${t}%`, `merchant_name.ilike.%${t}%`]);
        if (ors.length) q = q.or(ors.join(","));
      }
      if (args.card_last_four) {
        const digits = String(args.card_last_four).replace(/\D/g, "");
        const ids = (cards ?? []).filter((c: any) => {
          const cd = (c.last_four || "").replace(/\D/g, "");
          return cd && (cd.endsWith(digits) || digits.endsWith(cd) || cd === digits);
        }).map((c: any) => c.id);
        if (ids.length) q = q.in("credit_card_id", ids); else return { rows: [], note: "No card matched that last-four." };
      }
      q = q.order("transaction_date", { ascending: false }).limit(5000);
      const { data, error } = await q;
      if (error) return { error: error.message };
      const rows = data ?? [];

      const group = args.group_by;
      if (group && group !== "none") {
        const norm = (s: string) => s.toLowerCase().replace(/\d+/g, " ").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
        const g = new Map<string, { key: string; count: number; total: number }>();
        for (const t of rows) {
          const key = group === "month" ? t.transaction_date.slice(0, 7)
            : group === "category" ? (t.category || "uncategorized")
            : group === "card" ? (sourceName(t) || "unknown")
            : norm(t.merchant_name || t.description || "");
          if (!key) continue;
          const e = g.get(key) ?? { key, count: 0, total: 0 };
          e.count++; e.total = Math.round((e.total + Number(t.amount || 0)) * 100) / 100;
          g.set(key, e);
        }
        return { grouped_by: group, matched: rows.length, groups: [...g.values()].sort((a, b) => b.total - a.total).slice(0, 60) };
      }

      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      return {
        matched: rows.length,
        rows: rows.slice(0, limit).map((t: any) => ({
          date: t.transaction_date, description: t.merchant_name || t.description,
          amount: t.amount, type: t.transaction_type, category: t.category, source: sourceName(t),
        })),
      };
    }

    const tools = [{
      name: "query_transactions",
      description: "Search or aggregate the user's COMPLETE transaction history (all years, thousands of rows). Use this for ANY question about spending, income, refunds, specific merchants, totals, trends, or date ranges. Call it as many times as needed. Amounts are USD; direction is given by transaction_type (expense/income/payment/transfer/refund/fee).",
      input_schema: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "YYYY-MM-DD inclusive lower bound" },
          end_date: { type: "string", description: "YYYY-MM-DD inclusive upper bound" },
          description_contains: { type: "string", description: "case-insensitive merchant/description substring, e.g. 'amazon'" },
          transaction_type: { type: "string", enum: ["expense", "income", "payment", "transfer", "refund", "fee"] },
          card_last_four: { type: "string", description: "filter to a card by its last 4-5 digits" },
          group_by: { type: "string", enum: ["none", "month", "merchant", "category", "card"], description: "aggregate the matches (returns count + total per group) instead of raw rows" },
          limit: { type: "integer", description: "max rows when group_by is none (default 50, max 500)" },
        },
      },
    }];

    const system =
      "You are a financial assistant for a personal/business finance dashboard. You can query the user's COMPLETE transaction history with the query_transactions tool — always use it for anything about spending, income, merchants, totals, or trends, rather than guessing or saying you lack history. " +
      "Make multiple tool calls if needed (e.g. per card, or to aggregate by month). All amounts are USD. Be concise and specific; include dates, amounts, and which card/account. " +
      "Credit-card 'refund'/'income' rows are money back (not revenue); 'payment' rows are card payments. Never invent numbers — base every figure on tool results. " +
      "The accounts and cards are provided in the first message; use the exact last_four shown there (it may be 5 digits) for card_last_four. " +
      "IMPORTANT — advertising/ad spend appears under many merchant names in this data, NOT the word 'advertising'. When asked about advertising or ads, pass these as comma-separated terms in description_contains: 'sponsored,marketing svcs,marketing services,advertis,ads,tiktok ads,google ads,meta,facebook,product ads', and sum across all matches. " +
      "description_contains accepts comma-separated terms (OR-matched), so search several name variants in one call.";

    const model = Deno.env.get("ASK_MODEL") ?? "claude-haiku-4-5";
    const messages: any[] = [{
      role: "user",
      content: `ACCOUNTS & CARDS:\n${JSON.stringify(context)}\n\nQUESTION: ${question}`,
    }];

    // Tool-use loop.
    let answer = "";
    for (let i = 0; i < 6; i++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1500, system, tools, messages }),
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error("Anthropic error", res.status, detail.slice(0, 500));
        if (res.status === 429) return json({ error: "Rate limited — try again shortly." }, 429);
        return json({ error: `AI request failed (${res.status})` }, 502);
      }
      const data = await res.json();
      messages.push({ role: "assistant", content: data.content });

      if (data.stop_reason === "tool_use") {
        const results = [];
        for (const block of data.content) {
          if (block.type === "tool_use" && block.name === "query_transactions") {
            const out = await runQuery(block.input || {});
            results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out).slice(0, 60000) });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      answer = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      break;
    }

    return json({ answer: answer || "No answer returned." });
  } catch (error) {
    console.error("ask error:", error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
