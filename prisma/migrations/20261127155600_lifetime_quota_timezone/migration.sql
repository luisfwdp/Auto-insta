-- Grant timestamps are stored as UTC without a zone. Limit the comparison's
-- time zone to this trigger function so it matches the application's decision.
ALTER FUNCTION "commercial_usage_binding_valid"() SET timezone TO 'UTC';
