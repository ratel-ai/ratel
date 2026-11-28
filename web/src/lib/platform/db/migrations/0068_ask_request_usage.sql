-- Decision ask-trial-fixes: each ask keeps the input and output tokens of its calls and its repair
-- rounds, next to its model and its USD, so a cost can be checked against the bill. Columns with a
-- constant default on a small table: no rewrite.
ALTER TABLE "ask_requests" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ask_requests" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ask_requests" ADD COLUMN "repair_rounds" integer DEFAULT 0 NOT NULL;