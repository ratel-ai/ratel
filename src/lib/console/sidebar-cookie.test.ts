import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSidebarCollapsedCookie,
  SIDEBAR_COLLAPSED_COOKIE,
  serializeSidebarCollapsedCookie,
} from "@/lib/console/sidebar-cookie";

test("sidebar cookie collapses only for the explicit persisted value", () => {
  assert.deepEqual(
    [
      parseSidebarCollapsedCookie("1"),
      parseSidebarCollapsedCookie("0"),
      parseSidebarCollapsedCookie("true"),
      parseSidebarCollapsedCookie(undefined),
    ],
    [true, false, false, false],
  );
});

test("sidebar cookie serialization is durable and site-scoped", () => {
  assert.equal(
    serializeSidebarCollapsedCookie(true),
    `${SIDEBAR_COLLAPSED_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
  assert.equal(
    serializeSidebarCollapsedCookie(false),
    `${SIDEBAR_COLLAPSED_COOKIE}=0; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
});
