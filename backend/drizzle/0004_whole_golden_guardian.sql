DROP INDEX "file_credits_file_idx";--> statement-breakpoint
ALTER TABLE "file_credits" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "file_credits_file_idx" ON "file_credits" USING btree ("file_id","seq");