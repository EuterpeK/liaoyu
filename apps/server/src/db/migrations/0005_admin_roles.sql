CREATE TYPE "public"."admin_role" AS ENUM('super', 'ops', 'finance');--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "role" "admin_role" DEFAULT 'super' NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "disabled_at" timestamp with time zone;