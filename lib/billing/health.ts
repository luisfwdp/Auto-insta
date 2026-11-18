import { prisma } from "@/lib/db/client";
import { getBillingProviderScope } from "./config";

/** Operational aggregate only. No resource IDs or payer details leave the DB. */
export async function readBillingDeadLetters(): Promise<number> {
  const scope = getBillingProviderScope();
  const [events, commands] = await Promise.all([
    prisma.billingEvent.count({ where: { ...scope, status: "DEAD" } }),
    prisma.billingCommand.count({ where: { status: "DEAD", subscription: scope } }),
  ]);
  return events + commands;
}
