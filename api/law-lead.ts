import { captureLead } from "../lib/hubspot";
import { guard } from "../lib/rateLimit";

export const config = { runtime: "edge" };

/**
 * Law Firm Growth landing page enquiries (/law-firm-marketing).
 *
 * Both forms on the page ("Book a 20-minute growth call") post here. The lead
 * goes to HubSpot through captureLead (contact + Slack + HubSpot form, the same
 * path as the audit and the labs), and a full-detail alert is emailed to
 * LEAD_NOTIFY_EMAIL through Resend, because the suburb, spend and practice
 * areas don't have HubSpot properties yet.
 *
 * Both are best-effort and run in parallel. Either one landing counts: the
 * browser shows the "done" state, so a lead must never be lost silently.
 * Unconfigured, both stub to the function log.
 */

type Body = {
  name?: string;
  firm?: string;
  phone?: string;
  email?: string;
  suburb?: string;
  monthly_spend?: string;
  practice_areas?: string[];
  website?: string; // honeypot
  form?: string;
  clickIds?: Record<string, string>;
};

const SOURCE = "Law Firm Growth page";
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Honeypot: a person never fills a field they can't see. Answer 200 so a
  // bot learns nothing.
  if (clip(body.website, 200)) return json({ ok: true });

  const name = clip(body.name, 120);
  const firm = clip(body.firm, 160);
  const phone = clip(body.phone, 40);
  const email = clip(body.email, 200);
  const suburb = clip(body.suburb, 120);
  const spend = clip(body.monthly_spend, 60);
  const areas = (Array.isArray(body.practice_areas) ? body.practice_areas : [])
    .map((a) => clip(a, 60))
    .filter(Boolean)
    .slice(0, 12);
  const form = clip(body.form, 40) === "lead-final" ? "bottom form" : "top form";

  if (!name) return json({ error: "Please add your name." }, 400);
  if (!firm) return json({ error: "Please add your firm name." }, 400);
  if (phone.replace(/\D/g, "").length < 6) return json({ error: "Please add a valid phone number." }, 400);
  if (!emailRe.test(email)) return json({ error: "That email address doesn't look right." }, 400);

  const blocked = await guard(req, "law-lead");
  if (blocked) return blocked;

  const lead = { name, firm, phone, email, suburb, spend, areas, form };
  console.log("[law-lead]", { firm, email, suburb, spend, areas: areas.join(", "), form });

  const [hubspot, mail] = await Promise.allSettled([
    captureLead({
      email,
      firstname: name.split(/\s+/)[0],
      company: firm,
      phone,
      website: "",
      source: SOURCE,
      clickIds: body.clickIds,
    }),
    sendAlert(lead),
  ]);
  if (hubspot.status === "rejected") console.warn("[law-lead] hubspot:", String(hubspot.reason));
  if (mail.status === "rejected") console.warn("[law-lead] email:", String(mail.reason));

  return json({ ok: true });
}

async function sendAlert(p: {
  name: string; firm: string; phone: string; email: string;
  suburb: string; spend: string; areas: string[]; form: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LEAD_NOTIFY_FROM || "onboarding@resend.dev";
  const to = (process.env.LEAD_NOTIFY_EMAIL || "").split(",").map((e) => e.trim()).filter(Boolean);
  if (!apiKey || !to.length) {
    console.log("[law-lead:email-stub]", p.email);
    return;
  }

  const row = (label: string, value: string) =>
    value
      ? `<tr><td style="padding:6px 12px 6px 0;color:#6B6B6B;width:150px;vertical-align:top;">${label}</td><td style="padding:6px 0;">${value}</td></tr>`
      : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.55;color:#0F0F0F;max-width:680px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;margin:0 0 4px;">New law firm enquiry</h1>
  <p style="color:#6B6B6B;margin:0 0 24px;">${SOURCE} · ${esc(p.form)} · wants a 20-minute growth call</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    ${row("Name", esc(p.name))}
    ${row("Firm", esc(p.firm))}
    ${row("Phone", `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`)}
    ${row("Email", `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`)}
    ${row("Suburb or city", esc(p.suburb))}
    ${row("Monthly spend", esc(p.spend))}
    ${row("Practice areas", esc(p.areas.join(", ")))}
  </table>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: `New law firm enquiry · ${p.firm} · ${p.suburb || p.email}`, html, reply_to: p.email }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
  }
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
