import { createAsaasClient } from "./asaas-client";
import { BillingError, getBillingProviderScope } from "./config";
import { createPulsoClient } from "./pulso-checkout";

export function createBillingGateway() {
  if (process.env.PULSO_CHECKOUT_ENABLED !== "true") return createAsaasClient();
  const { environment } = getBillingProviderScope();
  const transport = createPulsoClient(environment);
  if (!transport) throw new BillingError("BILLING_CONFIGURATION", 503);
  return createAsaasClient(process.env, fetch, transport);
}
