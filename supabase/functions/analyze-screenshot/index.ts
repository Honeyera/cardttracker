import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Input validation schema
const imageSchema = z.object({
  imageBase64: z.string()
    .min(100, "Image data too small")
    .max(10 * 1024 * 1024, "Image too large (max 10MB)")
    .refine((val) => {
      return val.startsWith('data:image/') || /^[A-Za-z0-9+/=]+$/.test(val.substring(0, 100));
    }, 'Invalid image format')
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized - Authentication required' }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse and validate input
    const requestData = await req.json();
    const validationResult = imageSchema.safeParse(requestData);
    
    if (!validationResult.success) {
      return new Response(
        JSON.stringify({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { imageBase64 } = validationResult.data;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

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
            content: `You are an expert at analyzing credit card screenshots from banking apps and statements.

CRITICAL - CARD NUMBER EXTRACTION:
- Look for text patterns like "ending in XXXXX", "...XXXXX", "****XXXXX", "x-XXXXX", or a masked card number showing the last digits
- The card number is usually displayed near the card name or at the top of the card details
- In Chase app: look for "Account ending in" followed by digits
- Extract EXACTLY the digits shown - do not guess or infer digits
- lastFiveDigits: MUST be exactly 5 characters as a STRING (e.g., "01012", "91012"). Preserve leading zeros!

Extract credit card information from the image. For each card found, extract:
- name: The card name/type (e.g., "Chase Sapphire", "Amex Gold", "Chase Freedom")
- lastFiveDigits: EXACTLY the last 5 digits as shown after "ending in" or similar text. This MUST be a 5-character STRING, preserving any leading zeros. If fewer than 5 digits are visible, pad with zeros on the left. If no digits visible, use "00000".
- closingDay: The statement closing day of the month (1-31)
- dueDay: The payment due day of the month (1-31)
- remainingStatementBalance: The STATEMENT BALANCE or REMAINING STATEMENT BALANCE - the amount due from the last billing cycle. Look for labels like "Statement balance", "Last statement balance", "Remaining statement balance", "Amount due", "Minimum due". This is the amount the user needs to pay. Extract the NUMBER ONLY without $ or commas (e.g., 1234.56 not "$1,234.56").
- totalBalance: The CURRENT/TOTAL BALANCE - the full amount currently owed including recent transactions. Look for labels like "Current balance", "Total balance", "Balance". This is usually the larger number. Extract the NUMBER ONLY without $ or commas.
- creditLimit: The credit limit if visible (number only, no currency symbol)
- paymentStatus: If you see text like "Payment not required at this time", "No payment due", "Paid in full", or similar status messages, include the exact text here. Otherwise, leave it null.

CHASE APP SPECIFIC: In Chase app screenshots:
- "Current balance" = totalBalance (the full amount owed now)
- "Statement balance" or "Last statement balance" = remainingStatementBalance (what's due from billing cycle)
- Look for both values - they are usually displayed prominently

CRITICAL RULES:
1. lastFiveDigits must ALWAYS be exactly 5 characters, as a STRING with quotes. Never return it as a number.
2. ALL balance values must be NUMBERS, not strings. Remove $ signs and commas before returning.
3. If you see "$1,234.56", return 1234.56 as the number.
4. BOTH remainingStatementBalance AND totalBalance should be extracted if visible - they are different values!

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
            content: [
              {
                type: "text",
                text: "Please analyze this screenshot and extract all credit card information you can find."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`
                }
              }
            ]
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
      console.error("AI gateway error:", response.status);
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
      // Try to extract JSON if wrapped in markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      parsedCards = JSON.parse(jsonStr.trim());
      console.log("Parsed cards count:", parsedCards?.cards?.length || 0);
    } catch (e) {
      console.error("Failed to parse AI response, length:", content?.length || 0);
      throw new Error("Failed to parse card data from image");
    }

    return new Response(
      JSON.stringify(parsedCards),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error analyzing screenshot:", error instanceof Error ? error.message : "Unknown error");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
