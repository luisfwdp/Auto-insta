import { NextResponse } from "next/server";
import { z } from "zod";
import { offerCookie, pulsoOfferPlan } from "@/lib/billing/pulso-offer";

const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

export async function GET(request: Request, { params }: { params: Promise<{ reference: string }> }) {
  const reference = z.uuid().safeParse((await params).reference);
  const query = new URL(request.url).searchParams;
  const plan = pulsoOfferPlan.safeParse(query.get("plan"));
  if (!reference.success || !plan.success || query.size !== 1) return new Response(null, { status: 404, headers: privateHeaders });

  const response = new NextResponse(null, { status: 303, headers: {
    ...privateHeaders, Location: `/pricing?plan=${plan.data}#plan-${plan.data}`,
  } });
  if (process.env.PULSO_CHECKOUT_ENABLED === "true") response.cookies.set(offerCookie(plan.data, reference.data));
  return response;
}
