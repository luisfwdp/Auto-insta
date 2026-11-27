ALTER TABLE "TrackedLink" ADD COLUMN "requireLead" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Automation_id_workspaceId_key" ON "Automation"("id", "workspaceId");

CREATE TABLE "CampaignLead" (
  "id" UUID NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "automationId" TEXT NOT NULL,
  "sourceLinkId" TEXT NOT NULL,
  "contactCiphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignLead_automationId_workspaceId_fkey"
    FOREIGN KEY ("automationId", "workspaceId") REFERENCES "Automation"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CampaignLead_workspaceId_automationId_createdAt_id_idx"
  ON "CampaignLead"("workspaceId", "automationId", "createdAt", "id");

ALTER TABLE "CampaignLead" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CampaignLead" FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'pingchat_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE %I."CampaignLead" FROM %I', current_schema(), role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pingchat_runtime') THEN
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I."CampaignLead" TO pingchat_runtime', current_schema());
    EXECUTE format('CREATE POLICY backend_leads_read ON %I."CampaignLead" FOR SELECT TO pingchat_runtime USING (true)', current_schema());
    EXECUTE format('CREATE POLICY backend_leads_insert ON %I."CampaignLead" FOR INSERT TO pingchat_runtime WITH CHECK (true)', current_schema());
    EXECUTE format('CREATE POLICY backend_leads_delete ON %I."CampaignLead" FOR DELETE TO pingchat_runtime USING (true)', current_schema());
  END IF;
END $$;
