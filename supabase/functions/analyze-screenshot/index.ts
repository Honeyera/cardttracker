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
    const { imageBase64 } = await req.json();
    
    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "No image provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
            content: `You are an expert at analyzing credit card screenshots and statements. 
Extract credit card information from the image. For each card found, extract:
- name: The card name/type (e.g., "Chase Sapphire", "Amex Gold")
- lastFiveDigits: EXACTLY the last 5 digits of the card number as shown on screen. IMPORTANT: This MUST be a 5-character STRING, preserving any leading zeros (e.g., "01234", "00567"). If fewer than 5 digits are visible, pad with zeros on the left. If no digits visible, use "00000".
- closingDay: The statement closing day of the month (1-31)
- dueDay: The payment due day of the month (1-31)
- remainingStatementBalance: The remaining statement balance - the amount still owed on the current statement (number only, no currency symbol). This is sometimes labeled "Statement Balance", "Remaining Balance", "Amount Due", or similar.
- totalBalance: The total balance on the card - the full amount owed including pending transactions (number only, no currency symbol). This is sometimes labeled "Total Balance", "Current Balance", "Total Amount", or similar.
- creditLimit: The credit limit if visible (number only, no currency symbol)
- paymentStatus: If you see text like "Payment not required at this time", "No payment due", "Paid in full", or similar status messages, include the exact text here. Otherwise, leave it null.

CRITICAL: lastFiveDigits must ALWAYS be exactly 5 characters, as a STRING with quotes. Never return it as a number.
IMPORTANT: Distinguish between remainingStatementBalance (what's due on the statement) and totalBalance (total owed on the card). If only one balance is shown, put it in totalBalance.

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
If a field is not visible, use reasonable defaults: closingDay=15, dueDay=22, remainingStatementBalance=0, totalBalance=0.`
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
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

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
    } catch (e) {
      console.error("Failed to parse AI response:", content);
      throw new Error("Failed to parse card data from image");
    }

    return new Response(
      JSON.stringify(parsedCards),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error analyzing screenshot:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
