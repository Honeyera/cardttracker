import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const requestData = await req.json();
    const validationResult = imageSchema.safeParse(requestData);

    if (!validationResult.success) {
      return new Response(
        JSON.stringify({ error: "Invalid input", details: validationResult.error.errors }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { imageBase64 } = validationResult.data;

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const systemPrompt = `You are an expert at analyzing screenshots from banking apps, credit card portals, and rewards program pages.

Your task is to extract credit card reward POINTS balances (not dollar amounts) from the image.

WHAT TO LOOK FOR:
- Reward points, miles, cash back points, loyalty points
- Labels like: "Points", "Miles", "Rewards", "Available points", "Points balance", "Ultimate Rewards", "Membership Rewards", "ThankYou Points", "Cash Back", "Available miles"
- The points value is usually a large number with commas (e.g., 45,231 or 1,234,500)

CARD IDENTIFICATION:
- Look for card names like "Chase Sapphire Reserve", "Amex Gold", "Freedom Unlimited", etc.
- Look for masked card numbers showing last digits: "ending in XXXXX", "****XXXXX", "...XXXXX"
- lastFiveDigits: MUST be exactly 5 characters as a STRING, preserving leading zeros. Use "00000" if not visible.

IMPORTANT RULES:
1. Extract POINTS (integer numbers like 45231) not dollar amounts.
2. Remove any commas from point values — return as a plain integer (e.g., 45231 not "45,231").
3. lastFiveDigits must ALWAYS be exactly 5 characters as a STRING.
4. If you see both a "total" and "available" points value, use the AVAILABLE points (what can be redeemed now).
5. Do NOT confuse dollar amounts with points. Points are usually whole numbers in the thousands.

Return ONLY valid JSON in this exact format, no markdown:
{
  "cards": [
    {
      "name": "Card Name",
      "lastFiveDigits": "12345",
      "availablePoints": 45231
    }
  ]
}

If you cannot find any reward points information, return: {"cards": []}
If a field is not visible, use "00000" for lastFiveDigits and 0 for availablePoints.`;

    const imageUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;
    const mediaType = imageUrl.match(/^data:(image\/[^;]+)/)?.[1] || "image/png";
    const base64Data = imageUrl.replace(/^data:image\/[^;]+;base64,/, "");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data,
                }
              },
              {
                type: "text",
                text: "Please analyze this screenshot and extract all reward points balances you can find."
              }
            ]
          }
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Anthropic API error:", response.status, errorBody);

      let userMessage = `AI service error (${response.status}). Please try again later.`;
      try {
        const parsed = JSON.parse(errorBody);
        const msg = parsed?.error?.message || '';
        if (msg.toLowerCase().includes('credit balance') || msg.toLowerCase().includes('billing')) {
          userMessage = 'AI credits exhausted. Please add credits at console.anthropic.com to continue.';
        } else if (response.status === 429) {
          userMessage = 'Rate limit exceeded. Please try again in a moment.';
        } else if (msg) {
          userMessage = msg;
        }
      } catch {}

      return new Response(
        JSON.stringify({ error: userMessage }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;

    if (!content) {
      throw new Error("No content in AI response");
    }

    let parsedResult;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      parsedResult = JSON.parse(jsonStr.trim());
    } catch (e) {
      throw new Error("Failed to parse points data from image");
    }

    return new Response(
      JSON.stringify(parsedResult),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error analyzing points screenshot:", error instanceof Error ? error.message : "Unknown error");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
