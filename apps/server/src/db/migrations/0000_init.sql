CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid');--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('single', 'month', 'quarter', 'year');--> statement-breakpoint
CREATE TYPE "public"."relation_status" AS ENUM('active', 'ended', 'refunded', 'switched');--> statement-breakpoint
CREATE TYPE "public"."segment_kind" AS ENUM('normal', 'substitute', 'paused');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('pending', 'paid');--> statement-breakpoint
CREATE TYPE "public"."teacher_status" AS ENUM('pending', 'active', 'rejected', 'disabled');--> statement-breakpoint
CREATE TABLE "accruals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accruals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"relation_id" integer NOT NULL,
	"date" date NOT NULL,
	"teacher_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"settlement_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accruals_relation_date_uq" UNIQUE("relation_id","date")
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"admin_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"admin_id" integer,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"out_trade_no" text NOT NULL,
	"user_id" integer NOT NULL,
	"teacher_id" integer NOT NULL,
	"package_id" integer NOT NULL,
	"package_snapshot" jsonb NOT NULL,
	"amount_cents" bigint NOT NULL,
	"pay_provider" text NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"trade_no" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_out_trade_no_unique" UNIQUE("out_trade_no")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "packages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"teacher_id" integer NOT NULL,
	"type" "package_type" NOT NULL,
	"title" text NOT NULL,
	"price_cents" bigint NOT NULL,
	"days" integer NOT NULL,
	"call_quota" integer DEFAULT 0 NOT NULL,
	"reply_hours" integer DEFAULT 24 NOT NULL,
	"on_sale" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_price_positive" CHECK ("packages"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "service_relations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_relations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"teacher_id" integer NOT NULL,
	"package_type" "package_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"total_days" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"calls_left" integer DEFAULT 0 NOT NULL,
	"reply_hours" integer DEFAULT 24 NOT NULL,
	"status" "relation_status" DEFAULT 'active' NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_relations_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "relation_dates" CHECK ("service_relations"."end_date" >= "service_relations"."start_date")
);
--> statement-breakpoint
CREATE TABLE "service_segments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"relation_id" integer NOT NULL,
	"kind" "segment_kind" NOT NULL,
	"teacher_id" integer,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	CONSTRAINT "segment_dates" CHECK ("service_segments"."end_date" >= "service_segments"."start_date"),
	CONSTRAINT "segment_teacher" CHECK (("service_segments"."kind" = 'paused') = ("service_segments"."teacher_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settlements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"teacher_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"gross_cents" bigint NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"proof" text,
	"operator_id" integer,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"real_name_enc" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"directions" text[] DEFAULT '{}'::text[] NOT NULL,
	"credentials" text[] DEFAULT '{}'::text[] NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"status" "teacher_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "teacher_level_range" CHECK ("teacher_profiles"."level" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"openid" text NOT NULL,
	"nickname" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_openid_unique" UNIQUE("openid")
);
--> statement-breakpoint
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_relation_id_service_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."service_relations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_relations" ADD CONSTRAINT "service_relations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_relations" ADD CONSTRAINT "service_relations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_relations" ADD CONSTRAINT "service_relations_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_segments" ADD CONSTRAINT "service_segments_relation_id_service_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."service_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_segments" ADD CONSTRAINT "service_segments_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_operator_id_admins_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_profiles" ADD CONSTRAINT "teacher_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accruals_teacher_date_idx" ON "accruals" USING btree ("teacher_id","date");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_teacher_idx" ON "orders" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "packages_teacher_idx" ON "packages" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "relations_user_teacher_idx" ON "service_relations" USING btree ("user_id","teacher_id");--> statement-breakpoint
CREATE INDEX "relations_teacher_idx" ON "service_relations" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "segments_relation_idx" ON "service_segments" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "settlements_teacher_idx" ON "settlements" USING btree ("teacher_id");