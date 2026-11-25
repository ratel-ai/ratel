CREATE TABLE "eval_judge_spend" (
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"usd" double precision NOT NULL,
	CONSTRAINT "eval_judge_spend_organization_id_day_pk" PRIMARY KEY("organization_id","day")
);
