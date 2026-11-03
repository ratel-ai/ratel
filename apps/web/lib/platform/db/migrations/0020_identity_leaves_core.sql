-- Organizations, users and memberships belong to the edition's identity module. No CASCADE: on a
-- database where private tables still reference them, this fails instead of dropping their keys.
ALTER TABLE "projects" DROP CONSTRAINT "projects_organization_id_organizations_id_fk";--> statement-breakpoint
DROP TABLE "memberships";--> statement-breakpoint
DROP TABLE "users";--> statement-breakpoint
DROP TABLE "organizations";
