import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { cards, chargeAmount } = await req.json();
    
    console.log('Received request for card recommendation:', { cardCount: cards?.length, chargeAmount });

    if (!cards || cards.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No cards provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      console.error('LOVABLE_API_KEY is not configured');
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    // Get current date info
    const today = new Date();
    const currentDay = today.getDate();
    const currentMonth = today.toLocaleString('default', { month: 'long' });
    const currentYear = today.getFullYear();

    // Prepare card info for the AI
    const cardInfo = cards.map((card: any) => ({
      name: card.name,
      lastFiveDigits: card.lastFiveDigits,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      currentBalance: card.currentBalance || 0,
      totalBalance: card.totalBalance || 0,
      creditLimit: card.creditLimit || 0,
      paymentStatus: card.paymentStatus || null,
    }));

    const systemPrompt = `You are a financial advisor AI that helps users optimize their credit card usage. Your task is to recommend the TOP 3 credit cards to use for a purchase to maximize the time before payment is due.

Key concepts:
- The CLOSING DATE (statement date) is when the billing cycle ends and the statement is generated
- The DUE DATE is when payment for that statement is due (typically 21-25 days after closing)
- If you charge AFTER the closing date, the charge goes on the NEXT billing cycle, giving you the longest time before payment

Strategy for maximum payment deferral:
1. Find cards where the closing date has JUST passed (you just missed it), meaning charges go to next cycle
2. Calculate days until the NEXT closing date + days until due date after that
3. Rank cards by combined days - highest is best

Today's date is ${currentMonth} ${currentDay}, ${currentYear}.

Respond with a JSON object in this exact format:
{
  "recommendations": [
    {
      "rank": 1,
      "cardName": "card name",
      "lastFiveDigits": "12345",
      "daysUntilPayment": number,
      "nextClosingDate": "Month Day",
      "paymentDueDate": "Month Day", 
      "explanation": "1-2 sentence explanation of why this card ranks here"
    },
    {
      "rank": 2,
      "cardName": "card name",
      "lastFiveDigits": "12345",
      "daysUntilPayment": number,
      "nextClosingDate": "Month Day",
      "paymentDueDate": "Month Day", 
      "explanation": "1-2 sentence explanation"
    },
    {
      "rank": 3,
      "cardName": "card name",
      "lastFiveDigits": "12345",
      "daysUntilPayment": number,
      "nextClosingDate": "Month Day",
      "paymentDueDate": "Month Day", 
      "explanation": "1-2 sentence explanation"
    }
  ]
}

If there are fewer than 3 cards, include only as many as available. Make sure to include the exact lastFiveDigits from the card data provided.`;

    const userPrompt = `I want to make a charge of $${chargeAmount.toLocaleString()}. 

Here are my credit cards:
${JSON.stringify(cardInfo, null, 2)}

Which are the TOP 3 cards I should use to get the longest time before I have to make a payment? Rank them from best to worst. Consider that if I charge after a card's closing date, the charge goes on the next billing cycle.`;

    console.log('Calling Lovable AI for recommendation...');

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI gateway error:', response.status, errorText);
      
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again in a moment.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'AI credits exhausted. Please add funds to continue.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    console.log('AI response received');

    const content = aiResponse.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in AI response');
    }

    let recommendation;
    try {
      recommendation = JSON.parse(content);
    } catch (e) {
      console.error('Failed to parse AI response, length:', content?.length || 0);
      throw new Error('Failed to parse AI recommendation');
    }

    console.log('Recommendation count:', recommendation?.recommendations?.length || 0);

    return new Response(
      JSON.stringify(recommendation),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in recommend-card function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
