CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "service_segments" ADD CONSTRAINT "service_segments_no_overlap"
  EXCLUDE USING gist ("relation_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);
--> statement-breakpoint
CREATE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
