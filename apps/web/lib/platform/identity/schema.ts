import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PlanLimits } from "@/lib/contracts/entitlements";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Who uses the platform and in which workspace (ADR-0030, owned fragment of the upstream
 * schema). Ownership is organization-based: projects, API keys and events belong to an
 * organization, not to a user. A user belongs to organizations through `memberships`, each
 * with a per-organization role; `users.current_organization_id` is the one they are viewing.
 *
 * The open-source edition has one local operator and one organization; the tables keep their
 * shape so the Cloud edition and every page that is organization-scoped work unchanged. Plan,
 * billing and credit columns are not here: they belong to the private edition's own tables.
 */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Editable, URL-safe identifier. Unique across all organizations; the immutable `id` stays
  // the canonical identity for ownership.
  slug: text("slug").notNull().unique(),
  // Per-organization limit overrides, merged over the edition's defaults by the entitlements
  // port. Null = plain defaults.
  limitOverrides: jsonb("limit_overrides").$type<Partial<PlanLimits>>(),
  // When this workspace's sample project was provisioned. A "we already did it" watermark, not
  // a pointer: it stays set after the sample project is deleted, which is what stops a deleted
  // demo from being resurrected on the owner's next request.
  demoProjectSeededAt: timestamp("demo_project_seeded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The identity provider's stable id for this user: the session port's `Principal.id`.
  externalId: text("external_id").notNull().unique(),
  username: text("username"),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  // The organization this user is currently viewing. Nullable so a user row can exist before
  // any membership, and so ON DELETE SET NULL heals the pointer when the organization goes;
  // the session bridge re-resolves it from `memberships` on each request.
  currentOrganizationId: uuid("current_organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  // The last project this user successfully visited. Read-time membership validation keeps
  // stale or foreign pointers from becoming navigation targets.
  lastProjectId: uuid("last_project_id").references(() => projects.id, { onDelete: "set null" }),
  // How this user left the guided product tour: "completed" or "skipped". Null = never
  // finished it, which is what makes the tour offer itself again.
  onboardingTourStatus: text("onboarding_tour_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Membership join table: a user belongs to an organization with a role ("admin" | "member",
 * see `OrgRole`). Unique on (user, organization); deleting either side cascades the row away.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_user_org_idx").on(t.userId, t.organizationId),
    index("memberships_org_id_idx").on(t.organizationId),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
