import { randomUUID } from "node:crypto";
import { isBillingEnabled } from "@/lib/billing/trial";
import { BillingError } from "@/lib/billing/config";
import { CommercialStorageError, prepareCommercialMediaUpload, confirmCommercialMediaUpload, deleteCommercialMedia } from "@/lib/billing/commercial-storage";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { ALLOWED_MEDIA, confirmAssetSchema, createAssetSchema } from "@/lib/publishing/schemas";
import { createSignedUpload, deletePrivateObject, inspectPrivateObject, matchesDeclaredMedia, mediaStoragePath } from "@/lib/publishing/storage";
import { requestLimitResponse } from "@/lib/api/request-rate-limit";

export const runtime = "nodejs";

function commercialError(error: unknown) {
  const known = error instanceof BillingError;
  return NextResponse.json({ success: false, error: "Media storage request could not be completed.", code: known ? error.code : "STORAGE_UNAVAILABLE" }, {
    status: known ? error.httpStatus : 503, headers: { "Cache-Control": "private, no-store", ...(error instanceof CommercialStorageError && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
  });
}

async function access(write = false) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return { response: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  if (write) {
    if (!canManageWorkspace(context.role)) return { response: NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 }) };
    const denied = await requestLimitResponse("media", context.workspaceId);
    if (denied) return { response: denied };
  }
  return { context };
}

export async function GET(request: NextRequest) {
  const result = await access();
  if (result.response) return result.response;
  const { workspaceId } = result.context!;
  const status = request.nextUrl.searchParams.get("status");
  const assets = await prisma.publishingAsset.findMany({
    where: { workspaceId, ...(status && ["UPLOADING", "READY", "FAILED", "DELETED"].includes(status) ? { status: status as "UPLOADING" } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, filename: true, mimeType: true, mediaType: true, byteSize: true, width: true, height: true, durationMs: true, status: true, errorMessage: true, createdAt: true },
  });
  return NextResponse.json({ success: true, data: assets });
}

export async function POST(request: NextRequest) {
  const result = await access(true);
  if (result.response) return result.response;
  if (!canManageWorkspace(result.context!.role)) return NextResponse.json({ success: false, error: "Only owners and admins can upload media" }, { status: 403 });

  const parsed = createAssetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid media", details: parsed.error.flatten() }, { status: 400 });

  if (isBillingEnabled()) {
    try { return NextResponse.json({ success: true, data: await prepareCommercialMediaUpload(result.context!.workspaceId, parsed.data) }, { status: 201, headers: { "Cache-Control": "private, no-store" } }); }
    catch (error) { return commercialError(error); }
  }

  const id = randomUUID();
  const storagePath = mediaStoragePath(result.context!.workspaceId, id, parsed.data.filename);
  try {
    const signedUpload = await createSignedUpload(storagePath);
    const asset = await prisma.publishingAsset.create({
      data: {
        id,
        workspaceId: result.context!.workspaceId,
        filename: parsed.data.filename,
        storagePath,
        mimeType: parsed.data.mimeType,
        mediaType: ALLOWED_MEDIA[parsed.data.mimeType].mediaType,
        byteSize: parsed.data.byteSize,
        checksum: parsed.data.checksum,
      },
      select: { id: true, filename: true, mimeType: true, mediaType: true, byteSize: true, status: true },
    });
    return NextResponse.json({ success: true, data: { asset, signedUpload } }, { status: 201 });
  } catch {
    return NextResponse.json({ success: false, error: "Unable to prepare upload" }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const result = await access(true);
  if (result.response) return result.response;
  if (!canManageWorkspace(result.context!.role)) return NextResponse.json({ success: false, error: "Only owners and admins can confirm media" }, { status: 403 });
  const parsed = confirmAssetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid media confirmation", details: parsed.error.flatten() }, { status: 400 });

  if (isBillingEnabled()) {
    try {
      const confirmed = await confirmCommercialMediaUpload(result.context!.workspaceId, parsed.data);
      return confirmed.valid ? NextResponse.json({ success: true, data: confirmed.asset }, { headers: { "Cache-Control": "private, no-store" } })
        : NextResponse.json({ success: false, error: "Uploaded file failed media validation", code: "UPLOAD_VALIDATION_FAILED" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return commercialError(error); }
  }

  const asset = await prisma.publishingAsset.findFirst({ where: { id: parsed.data.id, workspaceId: result.context!.workspaceId } });
  if (!asset) return NextResponse.json({ success: false, error: "Media not found" }, { status: 404 });
  if (asset.status !== "UPLOADING") return NextResponse.json({ success: false, error: "Media is not awaiting upload" }, { status: 409 });
  const object = await inspectPrivateObject(asset.storagePath);
  if (!object) return NextResponse.json({ success: false, error: "Uploaded object was not found" }, { status: 409 });
  const allowed = ALLOWED_MEDIA[asset.mimeType as keyof typeof ALLOWED_MEDIA];
  if (!allowed || object.byteSize > allowed.maxBytes || !matchesDeclaredMedia(object.prefix, asset.mediaType)) {
    await prisma.publishingAsset.update({
      where: { id: asset.id },
      data: { status: "FAILED", errorMessage: "Uploaded file content does not match the declared media type or size" },
    });
    await deletePrivateObject(asset.storagePath).catch(() => undefined);
    return NextResponse.json({ success: false, error: "Uploaded file failed media validation" }, { status: 400 });
  }

  const updated = await prisma.publishingAsset.update({
    where: { id: asset.id },
    data: { status: "READY", byteSize: object.byteSize, width: parsed.data.width, height: parsed.data.height, durationMs: parsed.data.durationMs },
    select: { id: true, filename: true, mimeType: true, mediaType: true, byteSize: true, width: true, height: true, durationMs: true, status: true },
  });
  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest) {
  const result = await access(true);
  if (result.response) return result.response;
  if (!canManageWorkspace(result.context!.role)) return NextResponse.json({ success: false, error: "Only owners and admins can delete media" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Missing media ID" }, { status: 400 });
  if (isBillingEnabled()) {
    try { await deleteCommercialMedia(result.context!.workspaceId, id); return NextResponse.json({ success: true, data: { deleted: true } }, { headers: { "Cache-Control": "private, no-store" } }); }
    catch (error) { return commercialError(error); }
  }

  const asset = await prisma.publishingAsset.findFirst({ where: { id, workspaceId: result.context!.workspaceId }, include: { _count: { select: { publications: true } } } });
  if (!asset) return NextResponse.json({ success: false, error: "Media not found" }, { status: 404 });
  if (asset._count.publications > 0) return NextResponse.json({ success: false, error: "Media is in use by a publication" }, { status: 409 });
  await deletePrivateObject(asset.storagePath);
  await prisma.publishingAsset.update({ where: { id: asset.id }, data: { status: "DELETED" } });
  return NextResponse.json({ success: true, data: { deleted: true } });
}
