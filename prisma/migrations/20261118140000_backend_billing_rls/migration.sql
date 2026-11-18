-- Only the existing trusted application backend may use these server-only
-- tables. Table DML grants remain a separate prerequisite. Do not create a
-- role, grant membership/BYPASSRLS, disable RLS or expose browser/API roles.
-- Self-hosted installs without this role retain the existing default deny.
DO $$
DECLARE
  backend_role CONSTANT text := 'pingchat_runtime';
  table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = backend_role) THEN
    FOREACH table_name IN ARRAY ARRAY[
      'WorkspaceBilling', 'TrialRedemption', 'BillingCheckout',
      'BillingSubscription', 'BillingPayment', 'BillingEvent', 'BillingCommand',
      'CommercialUsageBucket', 'CommercialUsageReservation'
    ] LOOP
      EXECUTE format(
        'CREATE POLICY backend_billing_runtime ON %I.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
        current_schema(), table_name, backend_role
      );
    END LOOP;
  END IF;
END $$;
