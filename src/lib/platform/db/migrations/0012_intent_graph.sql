CREATE TABLE "intent_graph_clusters" (
	"project_id" uuid NOT NULL,
	"graph_key" text NOT NULL,
	"cluster_id" text NOT NULL,
	"label" text NOT NULL,
	"label_override" text,
	"terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"member_count" integer NOT NULL,
	"support" integer NOT NULL,
	"seeded_support" integer DEFAULT 0 NOT NULL,
	"last_ts" timestamp with time zone,
	"has_centroid" boolean NOT NULL,
	CONSTRAINT "intent_graph_clusters_project_id_graph_key_cluster_id_pk" PRIMARY KEY("project_id","graph_key","cluster_id")
);
--> statement-breakpoint
CREATE TABLE "intent_graph_edges" (
	"project_id" uuid NOT NULL,
	"graph_key" text NOT NULL,
	"cluster_id" text NOT NULL,
	"kind" text NOT NULL,
	"capability_id" text NOT NULL,
	"weight" double precision NOT NULL,
	"surfaced" integer,
	CONSTRAINT "intent_graph_edges_project_id_graph_key_cluster_id_kind_capability_id_pk" PRIMARY KEY("project_id","graph_key","cluster_id","kind","capability_id")
);
--> statement-breakpoint
CREATE TABLE "intent_graph_revisions" (
	"project_id" uuid NOT NULL,
	"graph_key" text NOT NULL,
	"rev" bigint NOT NULL,
	"document" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"cluster_count" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intent_graph_revisions_project_id_graph_key_rev_pk" PRIMARY KEY("project_id","graph_key","rev")
);
--> statement-breakpoint
CREATE TABLE "intent_graph_shadow_turns" (
	"project_id" uuid NOT NULL,
	"graph_key" text NOT NULL,
	"search_event_id" uuid NOT NULL,
	"source_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"plain_ids" jsonb NOT NULL,
	"boosted_ids" jsonb NOT NULL,
	"matched" boolean DEFAULT false NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"reported" boolean DEFAULT false NOT NULL,
	"invoked_tool_id" text,
	CONSTRAINT "intent_graph_shadow_turns_project_id_graph_key_search_event_id_pk" PRIMARY KEY("project_id","graph_key","search_event_id")
);
--> statement-breakpoint
CREATE TABLE "intent_graphs" (
	"project_id" uuid NOT NULL,
	"graph_key" text NOT NULL,
	"producer" text NOT NULL,
	"document" jsonb NOT NULL,
	"rev" bigint NOT NULL,
	"schema_version" integer NOT NULL,
	"model" text,
	"built_from_ts" timestamp with time zone NOT NULL,
	"cluster_count" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pulled_at" timestamp with time zone,
	"live_at" timestamp with time zone,
	CONSTRAINT "intent_graphs_project_id_graph_key_pk" PRIMARY KEY("project_id","graph_key")
);
--> statement-breakpoint
ALTER TABLE "intent_graph_clusters" ADD CONSTRAINT "intent_graph_clusters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_graph_edges" ADD CONSTRAINT "intent_graph_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_graph_revisions" ADD CONSTRAINT "intent_graph_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_graph_shadow_turns" ADD CONSTRAINT "intent_graph_shadow_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_graphs" ADD CONSTRAINT "intent_graphs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "intent_graph_clusters_project_key_support_idx" ON "intent_graph_clusters" USING btree ("project_id","graph_key","support");
--> statement-breakpoint
CREATE INDEX "intent_graph_edges_capability_idx" ON "intent_graph_edges" USING btree ("project_id","kind","capability_id");
--> statement-breakpoint
CREATE INDEX "intent_graph_revisions_project_key_received_idx" ON "intent_graph_revisions" USING btree ("project_id","graph_key","received_at");
--> statement-breakpoint
CREATE INDEX "intent_graph_shadow_turns_graph_time_idx" ON "intent_graph_shadow_turns" USING btree ("project_id","graph_key","occurred_at");
--> statement-breakpoint
CREATE INDEX "intent_graphs_project_updated_idx" ON "intent_graphs" USING btree ("project_id","updated_at");
