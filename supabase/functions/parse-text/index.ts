import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text } = await req.json();
    
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "No text provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    console.log("Parsing text input, length:", text.length);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are an expert at parsing credit card information from copied text. The text may come from banking apps, statements, emails, or other sources.

CRITICAL - CARD NUMBER EXTRACTION:
- Look for patterns like "ending in XXXXX", "...XXXXX", "****XXXXX", "x-XXXXX", "Account ending in", or partial card numbers
- Extract EXACTLY the digits shown - do not guess or infer digits
- lastFiveDigits: MUST be exactly 5 characters as a STRING (e.g., "01012", "91012"). Preserve leading zeros!

Extract credit card information from the text. For each card found, extract:
- name: The card name/type (e.g., "Chase Sapphire", "Amex Gold", "Ink Unlimited")
- lastFiveDigits: EXACTLY the last 5 digits as shown. This MUST be a 5-character STRING, preserving any leading zeros. If fewer than 5 digits are visible, pad with zeros on the left. If no digits visible, use "00000".
- closingDay: The statement closing day of the month (1-31)
- dueDay: The payment due day of the month (1-31)
- remainingStatementBalance: The STATEMENT BALANCE - the amount due from the billing cycle. Look for "Statement balance", "Amount due", "Minimum due". Extract NUMBER ONLY (e.g., 1234.56 not "$1,234.56").
- totalBalance: The CURRENT/TOTAL BALANCE - the full amount owed. Look for "Current balance", "Total balance". Extract NUMBER ONLY.
- creditLimit: The credit limit if visible (number only)
- paymentStatus: If you see "Payment not required", "No payment due", "Paid in full", include the text. Otherwise null.

PARSING RULES:
1. lastFiveDigits must ALWAYS be exactly 5 characters, as a STRING with quotes.
2. ALL balance values must be NUMBERS, not strings. Remove $ signs and commas.
3. If you see "$1,234.56", return 1234.56 as the number.
4. Extract BOTH remainingStatementBalance AND totalBalance if both are present.
5. If the same card info appears multiple times, only return it once.

Return ONLY valid JSON in this exact format, no markdown:
{
  "cards": [
    {
      "name": "Card Name",
      "lastFiveDigits": "12345",
      "closingDay": 15,
      "dueDay": 22,
      "remainingStatementBalance": 500.00,
      "totalBalance": 1234.56,
      "creditLimit": 10000,
      "paymentStatus": null
    }
  ]
}

If you cannot find any credit cards, return: {"cards": []}
If a field is not visible, use reasonable defaults: closingDay=15, dueDay=22. For balances, only use 0 if you truly cannot find any balance information.`
          },
          {
            role: "user",
            content: `Please parse the following text and extract all credit card information:\n\n${text}`
          }
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add more credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    console.log("AI response received, length:", content?.length || 0);

    if (!content) {
      throw new Error("No content in AI response");
    }

    // Parse the JSON from the response
    let parsedCards;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      parsedCards = JSON.parse(jsonStr.trim());
      console.log("Parsed cards count:", parsedCards?.cards?.length || 0);
    } catch (e) {
      console.error("Failed to parse AI response, length:", content?.length || 0);
      throw new Error("Failed to parse card data from text");
    }

    return new Response(
      JSON.stringify(parsedCards),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error parsing text:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
