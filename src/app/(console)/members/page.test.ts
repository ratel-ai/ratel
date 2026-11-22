import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { composition } from "@/lib/composition";
import LegacyMembersPage from "./page";

const editionUi = composition.ui;
const databaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  composition.ui = editionUi;
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
});

test("the old /members address is a 404 without the edition's members page", async () => {
  composition.ui = undefined;
  await assert.rejects(
    LegacyMembersPage({ searchParams: Promise.resolve({}) }),
    (err: { digest?: string }) => String(err.digest).includes("404"),
  );
});

test("with the edition's page but no organization to land in, it is still a 404", async () => {
  composition.ui = async () => ({
    RootProvider: () => null,
    AccountMenuItems: () => null,
    MembersPage: () => null,
  });
  await assert.rejects(
    LegacyMembersPage({ searchParams: Promise.resolve({}) }),
    (err: { digest?: string }) => String(err.digest).includes("404"),
  );
});
