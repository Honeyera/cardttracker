import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const fmt = (n: number) => n.toLocaleString("en-US");

// One balance card per card TYPE (Amex Gold / Chase) — points aren't
// interchangeable across types, so each is settled independently.
function balanceSection(label: string, tomer: number, leo: number): { html: string; text: string } {
  const diff = tomer - leo;
  const rows = `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
      <tr>
        <td style="padding:4px 0;color:#6b7280;">Tomer has taken</td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;color:#1d4ed8;font-weight:600;">${fmt(tomer)}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280;">Leo has taken</td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;color:#0d9488;font-weight:600;">${fmt(leo)}</td>
      </tr>
    </table>`;

  if (diff === 0) {
    return {
      html: `
      <div style="margin-top:14px;padding:16px;border-radius:10px;background:#ecfdf5;border:1px solid #a7f3d0;">
        <p style="margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:0.06em;color:#047857;text-transform:uppercase;">${escapeHtml(label)}</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#065f46;">All even ✓</p>
        ${rows}
      </div>`,
      text: `\n${label}: All even (Tomer ${fmt(tomer)} / Leo ${fmt(leo)})`,
    };
  }

  const taker = diff > 0 ? "Tomer" : "Leo";
  const owed = diff > 0 ? "Leo" : "Tomer";
  const amount = Math.abs(diff);
  return {
    html: `
      <div style="margin-top:14px;padding:16px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;">
        <p style="margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:0.06em;color:#92400e;text-transform:uppercase;">${escapeHtml(label)}</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#78350f;">
          ${owed} takes the next <span style="font-family:monospace;">${fmt(amount)}</span> pts to even out
        </p>
        ${rows}
        <p style="margin:8px 0 0;font-size:12px;color:#92400e;">${taker} is ahead by ${fmt(amount)} on ${escapeHtml(label)} points.</p>
      </div>`,
    text: `\n${label}: ${owed} takes the next ${fmt(amount)} pts (Tomer ${fmt(tomer)} / Leo ${fmt(leo)}; ${taker} ahead by ${fmt(amount)})`,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      person, card_name, last_five_digits: last_five_digits_raw, points_redeemed,
      redemption_date, notes, tomer_total, leo_total, entry_category,
      gold_tomer, gold_leo, chase_tomer, chase_leo,
    } = await req.json();
    const last_five_digits: string | null = last_five_digits_raw ?? null;

    // Per-category balances (preferred). Render a section only for a card type
    // that has ever had points taken, so a never-used type isn't noise.
    let balanceHtml = "";
    let balanceText = "";
    const haveCategories = [gold_tomer, gold_leo, chase_tomer, chase_leo].every((v: unknown) => Number.isFinite(v));
    if (haveCategories) {
      const sections: { html: string; text: string }[] = [];
      if (Number(gold_tomer) + Number(gold_leo) > 0) {
        sections.push(balanceSection("Amex (Gold) Balance", Number(gold_tomer), Number(gold_leo)));
      }
      if (Number(chase_tomer) + Number(chase_leo) > 0) {
        sections.push(balanceSection("Chase Balance", Number(chase_tomer), Number(chase_leo)));
      }
      balanceHtml = sections.map((s) => s.html).join("");
      balanceText = sections.map((s) => s.text).join("");
      if (balanceHtml) {
        balanceHtml = `
        <p style="margin:20px 0 0;font-size:11px;font-weight:600;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">Who takes what — by card type</p>
        ${balanceHtml}`;
      }
    } else if (Number.isFinite(tomer_total) && Number.isFinite(leo_total)) {
      // Back-compat: combined totals only.
      const s = balanceSection("Overall Balance", Number(tomer_total), Number(leo_total));
      balanceHtml = s.html;
      balanceText = s.text;
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const recipientsRaw = Deno.env.get("EMAIL_RECIPIENTS") ?? "";
    const recipients = recipientsRaw.split(",").map((e: string) => e.trim()).filter(Boolean);

    if (!resendApiKey || recipients.length === 0) {
      console.error("Missing config", { resendApiKey: !!resendApiKey, recipients });
      return new Response(
        JSON.stringify({ error: "Email configuration missing" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const dateStr = redemption_date
      ? new Date(redemption_date + "T00:00:00").toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        })
      : "Not specified";

    const pointsFormatted = Number(points_redeemed).toLocaleString("en-US");
    const cardDisplay = last_five_digits ? `${card_name} •••• ${last_five_digits}` : card_name;
    const typeLabel = entry_category === "gold" ? "Amex (Gold)" : entry_category === "chase" ? "Chase" : null;
    const subject = `CardTrack: ${person} redeemed ${pointsFormatted} ${typeLabel ?? ""} pts on ${cardDisplay}`.replace(/\s+/g, " ");

    const htmlBody = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#111827;padding:24px 28px;">
      <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.08em;color:#9ca3af;text-transform:uppercase;">CardTrack Points</p>
      <h1 style="margin:6px 0 0;font-size:22px;font-weight:700;color:#ffffff;">New Redemption Logged</h1>
    </div>
    <div style="padding:28px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;width:140px;">Person</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(person)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Card</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#111827;font-size:14px;">
            ${escapeHtml(card_name)}
            ${last_five_digits ? `<span style="color:#6b7280;font-family:monospace;font-size:12px;margin-left:6px;">•••• ${escapeHtml(last_five_digits)}</span>` : ""}
          </td>
        </tr>
        ${typeLabel ? `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Card Type</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#111827;font-size:14px;font-weight:600;">${typeLabel}</td>
        </tr>` : ""}
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Points Redeemed</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#111827;font-size:18px;font-weight:700;">${pointsFormatted}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Date</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#111827;font-size:14px;">${dateStr}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;vertical-align:top;">Notes</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;">${notes ? escapeHtml(notes) : '<span style="color:#9ca3af;">—</span>'}</td>
        </tr>
      </table>
      ${balanceHtml}
    </div>
    <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #f3f4f6;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">Sent from CardTrack · balances are per card type — Amex and Chase points settle separately</p>
    </div>
  </div>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "CardTrack <cardtrack@honeyera.com>",
        to: recipients,
        subject,
        html: htmlBody,
        text: `${person} redeemed ${pointsFormatted}${typeLabel ? ` ${typeLabel}` : ""} points on ${cardDisplay} (${dateStr})${notes ? `\nNotes: ${notes}` : ""}${balanceText}`,
      }),
    });

    const resBody = await res.json();

    if (!res.ok) {
      console.error("Resend error:", resBody);
      return new Response(
        JSON.stringify({ error: "Failed to send email", details: resBody }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Email sent via Resend:", resBody.id);

    return new Response(
      JSON.stringify({ success: true, id: resBody.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error?.message ?? error);
    return new Response(
      JSON.stringify({ error: "Failed to send email", details: String(error?.message ?? error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
