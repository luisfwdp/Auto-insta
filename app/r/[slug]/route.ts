import { NextRequest, NextResponse } from "next/server";
import { httpUrl } from "@/lib/api/http-url";
import { consumeRequestLimit } from "@/lib/api/request-rate-limit";
import { requestRateOrigin } from "@/lib/api/request-ip";
import { prisma } from "@/lib/db/client";
import { encryptLeadContact, leadContact, verifyLeadFormToken } from "@/lib/tracking/lead-capture";
import {
  getRequestIp,
  hashClickIp,
  parseRecipientToken,
} from "@/lib/tracking/server";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const MAX_FORM_BYTES = 4_096;

function formUrl(request: NextRequest, slug: string, status?: "invalid" | "expired" | "limit" | "unavailable") {
  const url = new URL(`/material/${encodeURIComponent(slug)}`, request.url);
  if (status) url.searchParams.set("status", status);
  return url;
}

async function readSmallForm(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(MAX_FORM_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_FORM_BYTES - length) {
        await reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      requireLead: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  await prisma.linkClick.create({
    data: {
      workspaceId: trackedLink.workspaceId,
      automationId: trackedLink.automationId,
      instagramAccountId: trackedLink.automation.instagramAccountId,
      trackedLinkId: trackedLink.id,
      ipHash: hashClickIp(getRequestIp(request)),
      recipientHash: parseRecipientToken(
        new URL(request.url).searchParams.get("r")
      ),
      userAgent: request.headers.get("user-agent"),
      referrer: request.headers.get("referer"),
    },
  });

  return NextResponse.redirect(
    trackedLink.requireLead ? formUrl(request, slug) : trackedLink.destinationUrl,
    { status: 302, headers: PRIVATE_HEADERS },
  );
}

export async function POST(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return new NextResponse(null, { status: 403, headers: PRIVATE_HEADERS });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
    return new NextResponse(null, { status: 415, headers: PRIVATE_HEADERS });
  }
  if (Number(request.headers.get("content-length")) > MAX_FORM_BYTES) {
    return new NextResponse(null, { status: 413, headers: PRIVATE_HEADERS });
  }
  const back = (status: "invalid" | "expired" | "limit" | "unavailable") =>
    NextResponse.redirect(formUrl(request, slug, status), { status: 303, headers: PRIVATE_HEADERS });

  try {
    if (!(await consumeRequestLimit("leadCapture", requestRateOrigin(request.headers))).allowed) return back("limit");
    const form = await readSmallForm(request);
    if (!form) return back("invalid");
    const { token, ...values } = Object.fromEntries(form);
    const contact = leadContact.safeParse(values);
    if (!contact.success) return back("invalid");
    const id = token ? verifyLeadFormToken(slug, token) : null;
    if (!id) return back("expired");

    const link = await prisma.trackedLink.findUnique({
      where: { slug },
      select: {
        id: true, workspaceId: true, automationId: true, requireLead: true, destinationUrl: true,
        automation: {
          select: { workspaceId: true, isActive: true, instagramAccount: { select: { workspaceId: true } } },
        },
      },
    });
    if (
      !link?.requireLead || !link.automation.isActive || link.workspaceId !== link.automation.workspaceId
      || link.workspaceId !== link.automation.instagramAccount.workspaceId
    ) {
      return new NextResponse(null, { status: 404, headers: PRIVATE_HEADERS });
    }
    const destination = httpUrl.safeParse(link.destinationUrl);
    if (!destination.success) return back("unavailable");

    await prisma.campaignLead.createMany({
      data: {
        id, workspaceId: link.workspaceId, automationId: link.automationId, sourceLinkId: link.id,
        contactCiphertext: encryptLeadContact(contact.data),
      },
      skipDuplicates: true,
    });
    return NextResponse.redirect(destination.data, { status: 303, headers: PRIVATE_HEADERS });
  } catch {
    return back("unavailable");
  }
}
