import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import ConsoleLayout from "@/app/(console)/layout";
import HomePage from "@/app/(console)/page";
import OnboardingPage from "@/app/onboarding/page";
import { ConsoleShell } from "@/components/console/shell/ConsoleShell";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition";
import type { EditionUi } from "@/lib/contracts/composition";

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

function useEdition(slots: Partial<EditionUi>): EditionUi {
  const ui: EditionUi = { RootProvider: () => null, AccountMenuItems: () => null, ...slots };
  composition.ui = async () => ui;
  return ui;
}

type Props = { children?: ReactNode };
const RootPage = () => null;
const Gate = ({ children }: Props) => children;
const Banner = () => null;

function layoutParts(tree: ReactElement<Props>) {
  const [banner, body] = tree.props.children as [ReactElement | null, ReactElement<Props>];
  return { banner, body };
}

test("OSS: the console renders the shell around the page, with no gate", async () => {
  composition.ui = undefined;
  const page = createElement("p");
  const { banner, body } = layoutParts(
    (await ConsoleLayout({ children: page })) as ReactElement<Props>,
  );
  assert.equal(banner, null);
  assert.equal(body.type, ConsoleShell);
  assert.equal(body.props.children, page);
});

test("an access gate wraps the shell before it renders, under the banner", async () => {
  const ui = useEdition({ ConsoleAccessGate: Gate, ConsoleBanner: Banner });
  const page = createElement("p");
  const { banner, body } = layoutParts(
    (await ConsoleLayout({ children: page })) as ReactElement<Props>,
  );
  assert.equal(banner?.type, Banner);
  assert.equal(body.type, Gate);
  const shell = body.props.children as ReactElement<{ ui: EditionUi; children: ReactNode }>;
  assert.equal(shell.type, ConsoleShell);
  assert.equal(shell.props.ui, ui);
  assert.equal(shell.props.children, page);
});

test("OSS: / keeps the console entry", async () => {
  composition.ui = undefined;
  const tree = (await HomePage()) as ReactElement;
  assert.equal(tree.type, DatabaseUnavailable);
});

test("an edition without RootPage keeps the console entry", async () => {
  useEdition({ ConsoleAccessGate: Gate });
  const tree = (await HomePage()) as ReactElement;
  assert.equal(tree.type, DatabaseUnavailable);
});

test("an edition's RootPage replaces /", async () => {
  useEdition({ RootPage });
  const tree = (await HomePage()) as ReactElement;
  assert.equal(tree.type, RootPage);
});

test("the access gate wraps the first-run screen too", async () => {
  const searchParams = Promise.resolve({});
  composition.ui = undefined;
  assert.equal(((await OnboardingPage({ searchParams })) as ReactElement).type, "main");
  useEdition({ ConsoleAccessGate: Gate });
  const gated = (await OnboardingPage({ searchParams })) as ReactElement<Props>;
  assert.equal(gated.type, Gate);
  assert.equal((gated.props.children as ReactElement).type, "main");
});
