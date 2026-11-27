import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Both are keyed on the organization id with no foreign key: identity is the edition's (ADR-0004),
 * as in `sample_project_seeds`. The secrets are sealed (`platform/secret-box`) for the row.
 */

/** The Slack app an organization saved; unused where the edition supplies one. */
export const slackApps = pgTable("slack_apps", {
  organizationId: uuid("organization_id").primaryKey(),
  clientId: text("client_id").notNull(),
  sealedSecret: text("sealed_secret").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The one Slack workspace of an organization. */
export const slackConnections = pgTable("slack_connections", {
  organizationId: uuid("organization_id").primaryKey(),
  teamId: text("team_id").notNull(),
  teamName: text("team_name").notNull(),
  sealedToken: text("sealed_token").notNull(),
  // Slack refused the token: someone must connect again.
  lostAt: timestamp("lost_at", { withTimezone: true }),
  connectedBy: text("connected_by").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
});
