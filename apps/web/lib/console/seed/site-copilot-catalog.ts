import { createHash } from "node:crypto";
import type { NewRuntimeCatalogEntry } from "@/lib/ingest/runtime-catalog/schema";

/**
 * Site Copilot: the field assistant of a general contractor, as the local
 * demo plays it back (`site-copilot-plan.ts` writes the conversations,
 * `site-copilot-otlp.ts` renders them as OpenTelemetry). This module holds its
 * tools and the projects, people and things its users ask about. Every name,
 * number and sentence here is invented: no customer text.
 */

export const SITE_COPILOT_AGENT = "site-copilot";
export const SITE_COPILOT_VERSION = "3.2.0";
/** A priced model, so the model-call rows carry a cost. */
export const SITE_COPILOT_MODEL = "claude-sonnet-4-6";
export const SITE_COPILOT_SYSTEM_PROMPT =
  "You are Site Copilot, the field assistant of a general contractor. Answer superintendents, project managers and " +
  "engineers about their job sites using the tools you have. Never invent a date, an amount or a status: when a tool " +
  "does not answer, say so.";

export const SITE_TOOL_IDS = [
  "list_projects",
  "get_project_info",
  "get_project_schedule",
  "check_weather_delay",
  "get_purchase_order",
  "track_material_delivery",
  "get_daily_log",
  "search_spec_book",
  "list_rfis",
  "get_rfi",
  "create_rfi",
  "get_change_order",
  "estimate_change_order",
  "get_pay_application",
  "check_payment_status",
  "list_subcontractors",
  "get_subcontractor_compliance",
  "log_safety_incident",
  "get_safety_checklist",
  "notify_team",
  "update_daily_log",
  "export_project_report",
] as const;

export type SiteToolId = (typeof SITE_TOOL_IDS)[number];

export interface SiteToolDef {
  id: SiteToolId;
  description: string;
  /** Parameter name to JSON type, for the tool menu's schema. */
  parameters: Readonly<Record<string, "string" | "integer">>;
}

/** The tool menu every model call is offered, in menu order. */
export const SITE_COPILOT_TOOLS: readonly SiteToolDef[] = [
  {
    id: "list_projects",
    description:
      "List the company's active construction projects with their ids, phase and superintendent.",
    parameters: { status: "string" },
  },
  {
    id: "get_project_info",
    description:
      "Get one project's record: address, owner, architect, phase and which documents are on file (spec book, drawings, permits).",
    parameters: { project_id: "string" },
  },
  {
    id: "get_project_schedule",
    description:
      "Read a project's schedule: activities with planned and forecast dates, float and what each one waits on.",
    parameters: { project_id: "string", activity: "string" },
  },
  {
    id: "check_weather_delay",
    description:
      "Check the 7-day forecast for a job site and flag weather risk to outdoor work on the schedule.",
    parameters: { project_id: "string", days: "integer" },
  },
  {
    id: "get_purchase_order",
    description:
      "Look up a purchase order by number, or a project's purchase orders for a material: supplier, items and promised delivery date.",
    parameters: { po_number: "string", project_id: "string", material: "string" },
  },
  {
    id: "track_material_delivery",
    description:
      "Track a delivery with the supplier's logistics service: shipped, in transit or delivered, with carrier and ETA.",
    parameters: { po_number: "string" },
  },
  {
    id: "get_daily_log",
    description:
      "Read a project's daily log: crews on site, deliveries received at the gate, work done and delays.",
    parameters: { project_id: "string", days: "integer" },
  },
  {
    id: "search_spec_book",
    description:
      "Search a project's specification book for a requirement and return the matching section.",
    parameters: { project_id: "string", query: "string" },
  },
  {
    id: "list_rfis",
    description: "List a project's RFIs with status, ball in court and due date.",
    parameters: { project_id: "string", status: "string" },
  },
  {
    id: "get_rfi",
    description: "Read one RFI: the question, the answer if there is one, attachments and history.",
    parameters: { project_id: "string", rfi_number: "string" },
  },
  {
    id: "create_rfi",
    description:
      "Draft a new RFI to the architect or engineer of record, saved for review before it is sent.",
    parameters: {
      project_id: "string",
      subject: "string",
      question: "string",
      to: "string",
      discipline: "string",
    },
  },
  {
    id: "get_change_order",
    description:
      "Read a change order or change request: scope, status, approved amount and backup.",
    parameters: { project_id: "string", co_number: "string" },
  },
  {
    id: "estimate_change_order",
    description:
      "Estimate a change order's cost from its scope, quantities and the current unit rates.",
    parameters: {
      project_id: "string",
      co_number: "string",
      scope: "string",
      labor_days: "integer",
      unit_rate_year: "integer",
    },
  },
  {
    id: "get_pay_application",
    description:
      "Read a project's pay applications: period, amount billed, retainage held and approval status.",
    parameters: { project_id: "string", period: "string" },
  },
  {
    id: "check_payment_status",
    description:
      "Check whether an owner payment or a supplier invoice has been received or paid, and when.",
    parameters: { pay_app_id: "string", invoice_number: "string" },
  },
  {
    id: "list_subcontractors",
    description: "List a project's subcontractors by trade with company, foreman and phone.",
    parameters: { project_id: "string", trade: "string" },
  },
  {
    id: "get_subcontractor_compliance",
    description:
      "Check a subcontractor's insurance certificate, license and site safety orientation status.",
    parameters: { project_id: "string", subcontractor_id: "string" },
  },
  {
    id: "log_safety_incident",
    description:
      "Record a safety incident or near miss: type, location, people involved and immediate actions.",
    parameters: { project_id: "string", type: "string", description: "string", location: "string" },
  },
  {
    id: "get_safety_checklist",
    description:
      "Get the pre-task safety checklist for a work activity such as a crane lift, excavation or hot work.",
    parameters: { activity: "string" },
  },
  {
    id: "notify_team",
    description: "Post a message to a project's team channel or to the safety manager.",
    parameters: { project_id: "string", channel: "string", message: "string" },
  },
  {
    id: "update_daily_log",
    description: "Add an entry to a project's daily log.",
    parameters: { project_id: "string", entry: "string" },
  },
  {
    id: "export_project_report",
    description: "Export a project status report as a PDF.",
    parameters: { project_id: "string", sections: "string" },
  },
];

/** In every menu, never called: what an unused-tool reading should find. */
export const SITE_COPILOT_UNUSED_TOOLS: readonly SiteToolId[] = [
  "update_daily_log",
  "export_project_report",
];

/** The tool menu as runtime catalog rows, so the Catalog lists what the agent is offered. */
export function siteCopilotCatalogEntries(projectId: string, now: Date): NewRuntimeCatalogEntry[] {
  return SITE_COPILOT_TOOLS.map(({ id, description }) => ({
    projectId,
    kind: "tool",
    entryId: id,
    name: id,
    description,
    tags: [],
    inputSchema: null,
    outputSchema: null,
    searchableDescription: description,
    searchableDescriptionOverridden: false,
    useCloudDefinitions: false,
    searchableDescriptionOverride: null,
    contentHash: createHash("sha256")
      .update(JSON.stringify([id, description]), "utf8")
      .digest("hex"),
    firstSeenAt: now,
    lastSeenAt: now,
  }));
}

export interface SiteProject {
  id: string;
  name: string;
  channel: string;
  architect: string;
  /** Whether the project's spec book is loaded; without it spec questions dead-end. */
  specBook: boolean;
  equipmentDesk: string;
}

export const SITE_PROJECTS: readonly SiteProject[] = [
  {
    id: "PRJ-2041",
    name: "Riverside MOB",
    channel: "#riverside-mob",
    architect: "Hollis Ward Architects",
    specBook: true,
    equipmentDesk: "Dana Ruiz at the yard",
  },
  {
    id: "PRJ-2047",
    name: "Northgate",
    channel: "#northgate",
    architect: "Studio Calder",
    specBook: true,
    equipmentDesk: "the Northgate site office",
  },
  {
    id: "PRJ-2052",
    name: "Lakeview Fire Station",
    channel: "#lakeview-fs",
    architect: "Meridian Design Group",
    specBook: true,
    equipmentDesk: "Dana Ruiz at the yard",
  },
  {
    id: "PRJ-2058",
    name: "Harbor Point",
    channel: "#harbor-point",
    architect: "Okafor and Lind",
    specBook: false,
    equipmentDesk: "Tom Becker in purchasing",
  },
  {
    id: "PRJ-2063",
    name: "City Hall Annex",
    channel: "#city-hall-annex",
    architect: "Meridian Design Group",
    specBook: true,
    equipmentDesk: "Tom Becker in purchasing",
  },
  {
    id: "PRJ-2066",
    name: "Eastside Middle School",
    channel: "#eastside-ms",
    architect: "Studio Calder",
    specBook: true,
    equipmentDesk: "the Eastside site office",
  },
];

export type SiteRole =
  | "superintendent"
  | "project_manager"
  | "project_engineer"
  | "safety_manager"
  | "foreman";

export interface SiteUser {
  id: string;
  role: SiteRole;
  /** Indexes into {@link SITE_PROJECTS}: the projects this person works on. */
  projects: readonly number[];
}

/** Twenty-four field and office users. Ids are opaque, as a customer's would be. */
export const SITE_USERS: readonly SiteUser[] = [
  { id: "usr_7d1f4a92c3", role: "superintendent", projects: [0] },
  { id: "usr_2b8e61d07f", role: "superintendent", projects: [1] },
  { id: "usr_9c40ab7e15", role: "superintendent", projects: [2] },
  { id: "usr_4e7a3c9b28", role: "superintendent", projects: [3] },
  { id: "usr_a13d58f6e0", role: "superintendent", projects: [4] },
  { id: "usr_63fb0d2a91", role: "superintendent", projects: [5] },
  { id: "usr_d58c27e4b6", role: "project_manager", projects: [0, 2] },
  { id: "usr_0fa9e6c371", role: "project_manager", projects: [1, 5] },
  { id: "usr_b7e2d40f5c", role: "project_manager", projects: [3, 4] },
  { id: "usr_5a6c9f13e8", role: "project_manager", projects: [0, 1] },
  { id: "usr_e24b7a0d96", role: "project_engineer", projects: [0] },
  { id: "usr_38d1c5f7a2", role: "project_engineer", projects: [1] },
  { id: "usr_c9f03e8b41", role: "project_engineer", projects: [2, 4] },
  { id: "usr_71ae4b2d0c", role: "project_engineer", projects: [3] },
  { id: "usr_f06d93a5b7", role: "project_engineer", projects: [5] },
  { id: "usr_1c5e8f7a3d", role: "safety_manager", projects: [0, 1, 2] },
  { id: "usr_8b2f6d1e94", role: "safety_manager", projects: [3, 4, 5] },
  { id: "usr_46e0a7c9f2", role: "foreman", projects: [0] },
  { id: "usr_ad37f1b85e", role: "foreman", projects: [1] },
  { id: "usr_5f9b2e60c7", role: "foreman", projects: [2] },
  { id: "usr_e8c41d7b30", role: "foreman", projects: [4] },
  { id: "usr_2d7a9c4f61", role: "project_manager", projects: [2, 3] },
  { id: "usr_9e15b8d2a7", role: "superintendent", projects: [0, 5] },
  { id: "usr_c62f0e9d14", role: "project_engineer", projects: [1, 3] },
];

export interface SiteMaterial {
  name: string;
  supplier: string;
  /** Purchase order numbers, one per project index. */
  poBase: number;
}

export const SITE_MATERIALS: readonly SiteMaterial[] = [
  { name: "switchgear", supplier: "Volt Line Supply", poBase: 1184 },
  { name: "curtain wall panels", supplier: "Northline Glazing", poBase: 1207 },
  { name: "rebar for the level 4 deck", supplier: "Ridge Steel", poBase: 1123 },
  { name: "precast stair units", supplier: "Keel Precast", poBase: 1251 },
  { name: "rooftop units", supplier: "Coolair Equipment", poBase: 1290 },
  { name: "elevator rails", supplier: "Lift Systems West", poBase: 1316 },
  { name: "steel joists", supplier: "Ridge Steel", poBase: 1142 },
  { name: "fire sprinkler pipe", supplier: "Delta Fire Supply", poBase: 1333 },
  { name: "drywall for levels 2 and 3", supplier: "Prairie Building Supply", poBase: 1372 },
  { name: "storefront doors", supplier: "Northline Glazing", poBase: 1398 },
];

/** A purchase order number that is stable for one material on one project. */
export function poNumberOf(material: SiteMaterial, projectIndex: number): string {
  return `PO-26-${material.poBase + projectIndex * 7}`;
}

export interface SiteActivity {
  name: string;
  /** Outdoor work is checked against the forecast. */
  outdoor: boolean;
}

export const SITE_ACTIVITIES: readonly SiteActivity[] = [
  { name: "L4 deck pour", outdoor: true },
  { name: "interior slab pour", outdoor: false },
  { name: "steel erection", outdoor: true },
  { name: "roof membrane", outdoor: true },
  { name: "curtain wall install", outdoor: true },
  { name: "MEP rough-in on level 2", outdoor: false },
  { name: "drywall hang on level 3", outdoor: false },
  { name: "site paving", outdoor: true },
  { name: "elevator install", outdoor: false },
  { name: "spray fireproofing", outdoor: false },
];

export interface SiteSpecItem {
  ask: string;
  section: string;
  answer: string;
}

export const SITE_SPEC_ITEMS: readonly SiteSpecItem[] = [
  {
    ask: "curing time before we can strip the deck forms",
    section: "03 30 00",
    answer: "7 days, or 75 percent of design strength by field-cured cylinders",
  },
  {
    ask: "R-value for the roof insulation",
    section: "07 22 00",
    answer: "R-30 continuous insulation above the deck",
  },
  {
    ask: "rebar cover in the grade beams",
    section: "03 20 00",
    answer: "3 inches where cast against earth, 2 inches elsewhere",
  },
  {
    ask: "fire rating for the corridor walls",
    section: "09 21 16",
    answer: "a 1-hour rating, UL design U419",
  },
  {
    ask: "sealant at the window perimeters",
    section: "07 92 00",
    answer: "a neutral-cure silicone, color to match the frames",
  },
  {
    ask: "concrete strength for the footings",
    section: "03 30 00",
    answer: "4,000 psi at 28 days",
  },
  {
    ask: "slab flatness for the polished concrete areas",
    section: "03 35 00",
    answer: "FF 50 and FL 35 overall",
  },
  {
    ask: "fireproofing thickness on the stair tower steel",
    section: "07 81 00",
    answer: "a 2-hour rating at the thickness the UL listing gives, 1-1/4 inch typical",
  },
];

export interface SiteSub {
  trade: string;
  company: string;
  foreman: string;
  phone: string;
}

export const SITE_SUBS: readonly SiteSub[] = [
  {
    trade: "electrical",
    company: "Brightline Electric",
    foreman: "Luis Ortega",
    phone: "555-0142",
  },
  { trade: "plumbing", company: "Keystone Plumbing", foreman: "Amy Tran", phone: "555-0178" },
  { trade: "HVAC", company: "Northair Mechanical", foreman: "Rob Kessler", phone: "555-0119" },
  { trade: "concrete", company: "Granite Concrete", foreman: "Sam Delgado", phone: "555-0155" },
  { trade: "steel", company: "Ironside Erectors", foreman: "Kyle Brandt", phone: "555-0131" },
  { trade: "drywall", company: "Summit Interiors", foreman: "Nina Patel", phone: "555-0166" },
  { trade: "roofing", company: "Peak Roofing", foreman: "Joe Marsh", phone: "555-0127" },
  { trade: "glazing", company: "Clearview Glass", foreman: "Erin Walsh", phone: "555-0193" },
];

export const SITE_EQUIPMENT: readonly string[] = [
  "scissor lift",
  "mini excavator",
  "telehandler",
  "60 ft boom lift",
  "skid steer",
  "pair of light towers",
  "rough terrain forklift",
];

export const SITE_INSPECTIONS: readonly string[] = [
  "above-ceiling MEP",
  "final electrical",
  "rough-in plumbing",
  "footing",
  "framing",
  "fire sprinkler hydro test",
  "underslab plumbing",
];

export const SITE_CHANGE_SCOPES: readonly string[] = [
  "adding two door openings in the level 2 corridor",
  "upsizing the storm line to 12 inch",
  "adding blocking for owner-furnished TVs",
  "moving the transformer pad 15 feet east",
  "a third coat of fireproofing at the stair towers",
  "adding a card reader at the north entry",
  "replacing the lobby tile with terrazzo",
];

export const SITE_RFI_SUBJECTS: readonly string[] = [
  "beam pocket conflict at grid C-4",
  "missing slab edge dimension at the east stair",
  "duct routing through the level 3 transfer beam",
  "door hardware set for the electrical rooms",
  "roof drain locations versus the joist layout",
  "embed plate size at the canopy",
];

export const SITE_INCIDENTS: readonly string[] = [
  "a bundle of rebar slipped off the forklift forks, nobody hurt",
  "a worker tripped on an unprotected floor opening on level 3",
  "a guardrail was missing at the roof edge on the north side",
  "a pump hose burst during the pour",
  "an excavator swung within 3 feet of a laborer",
];

export const SITE_CHECKLIST_TASKS: readonly string[] = [
  "crane lift",
  "excavation",
  "hot work",
  "confined space entry",
  "steel erection",
];
