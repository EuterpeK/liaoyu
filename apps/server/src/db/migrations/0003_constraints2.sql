CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_teacher_no_overlap"
  EXCLUDE USING gist ("teacher_id" WITH =, tstzrange("start_at", "end_at", '[)') WITH &&)
  WHERE ("status" = 'booked');
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_no_overlap"
  EXCLUDE USING gist ("teacher_id" WITH =, "weekday" WITH =, int4range("start_min", "end_min") WITH &&);
--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_no_overlap"
  EXCLUDE USING gist ("teacher_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);
