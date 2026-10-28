CREATE INDEX "accruals_unsettled_idx" ON "accruals" USING btree ("date") WHERE settlement_id IS NULL;--> statement-breakpoint
CREATE INDEX "accruals_relation_idx" ON "accruals" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "appointments_relation_idx" ON "appointments" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "appointments_booked_start_idx" ON "appointments" USING btree ("start_at") WHERE status = 'booked';--> statement-breakpoint
CREATE INDEX "appointments_booked_end_idx" ON "appointments" USING btree ("end_at") WHERE status = 'booked';--> statement-breakpoint
CREATE INDEX "appointments_confirm_pending_idx" ON "appointments" USING btree ("ended_at") WHERE confirm_status = 'pending';--> statement-breakpoint
CREATE INDEX "leave_choices_leave_idx" ON "leave_choices" USING btree ("leave_id");--> statement-breakpoint
CREATE INDEX "leave_choices_relation_idx" ON "leave_choices" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "leave_choices_pending_deadline_idx" ON "leave_choices" USING btree ("deadline_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "leaves_teacher_idx" ON "leaves" USING btree ("teacher_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "schedules_teacher_idx" ON "schedules" USING btree ("teacher_id","weekday");--> statement-breakpoint
CREATE INDEX "relations_active_end_idx" ON "service_relations" USING btree ("end_date") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "substitute_candidates_leave_idx" ON "substitute_candidates" USING btree ("leave_id");--> statement-breakpoint
CREATE INDEX "substitute_candidates_teacher_idx" ON "substitute_candidates" USING btree ("teacher_id","status");--> statement-breakpoint
CREATE INDEX "teacher_profiles_status_idx" ON "teacher_profiles" USING btree ("status");