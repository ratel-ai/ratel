/** Place codes: ISO 3166-1 alpha-2 for a country, ISO 3166-2 for a region. Pure, safe for the browser. */

export interface GeoCodes {
  country: string;
  region: string | null;
}

/** ISO 3166-1 numeric and alpha-2, as "020AD". */
const COUNTRIES =
  "004AF 008AL 010AQ 012DZ 016AS 020AD 024AO 028AG 031AZ 032AR 036AU 040AT 044BS 048BH 050BD " +
  "051AM 052BB 056BE 060BM 064BT 068BO 070BA 072BW 074BV 076BR 084BZ 086IO 090SB 092VG 096BN " +
  "100BG 104MM 108BI 112BY 116KH 120CM 124CA 132CV 136KY 140CF 144LK 148TD 152CL 156CN 158TW " +
  "162CX 166CC 170CO 174KM 175YT 178CG 180CD 184CK 188CR 191HR 192CU 196CY 203CZ 204BJ 208DK " +
  "212DM 214DO 218EC 222SV 226GQ 231ET 232ER 233EE 234FO 238FK 239GS 242FJ 246FI 248AX 250FR " +
  "254GF 258PF 260TF 262DJ 266GA 268GE 270GM 275PS 276DE 288GH 292GI 296KI 300GR 304GL 308GD " +
  "312GP 316GU 320GT 324GN 328GY 332HT 334HM 336VA 340HN 344HK 348HU 352IS 356IN 360ID 364IR " +
  "368IQ 372IE 376IL 380IT 384CI 388JM 392JP 398KZ 400JO 404KE 408KP 410KR 414KW 417KG 418LA " +
  "422LB 426LS 428LV 430LR 434LY 438LI 440LT 442LU 446MO 450MG 454MW 458MY 462MV 466ML 470MT " +
  "474MQ 478MR 480MU 484MX 492MC 496MN 498MD 499ME 500MS 504MA 508MZ 512OM 516NA 520NR 524NP " +
  "528NL 531CW 533AW 534SX 535BQ 540NC 548VU 554NZ 558NI 562NE 566NG 570NU 574NF 578NO 580MP " +
  "581UM 583FM 584MH 585PW 586PK 591PA 598PG 600PY 604PE 608PH 612PN 616PL 620PT 624GW 626TL " +
  "630PR 634QA 638RE 642RO 643RU 646RW 652BL 654SH 659KN 660AI 662LC 663MF 666PM 670VC 674SM " +
  "678ST 682SA 686SN 688RS 690SC 694SL 702SG 703SK 704VN 705SI 706SO 710ZA 716ZW 724ES 728SS " +
  "729SD 732EH 740SR 744SJ 748SZ 752SE 756CH 760SY 762TJ 764TH 768TG 772TK 776TO 780TT 784AE " +
  "788TN 792TR 795TM 796TC 798TV 800UG 804UA 807MK 818EG 826GB 831GG 832JE 833IM 834TZ 840US " +
  "850VI 854BF 858UY 860UZ 862VE 876WF 882WS 887YE 894ZM";

const COUNTRY_OF_NUMERIC = new Map(
  COUNTRIES.split(" ").map((pair) => [pair.slice(0, 3), pair.slice(3)]),
);

/** FIPS code, postal code and name of each state and territory, as the Census Bureau gives them. */
const US_STATES: readonly (readonly [string, string, string])[] = [
  ["01", "AL", "Alabama"],
  ["02", "AK", "Alaska"],
  ["04", "AZ", "Arizona"],
  ["05", "AR", "Arkansas"],
  ["06", "CA", "California"],
  ["08", "CO", "Colorado"],
  ["09", "CT", "Connecticut"],
  ["10", "DE", "Delaware"],
  ["11", "DC", "District of Columbia"],
  ["12", "FL", "Florida"],
  ["13", "GA", "Georgia"],
  ["15", "HI", "Hawaii"],
  ["16", "ID", "Idaho"],
  ["17", "IL", "Illinois"],
  ["18", "IN", "Indiana"],
  ["19", "IA", "Iowa"],
  ["20", "KS", "Kansas"],
  ["21", "KY", "Kentucky"],
  ["22", "LA", "Louisiana"],
  ["23", "ME", "Maine"],
  ["24", "MD", "Maryland"],
  ["25", "MA", "Massachusetts"],
  ["26", "MI", "Michigan"],
  ["27", "MN", "Minnesota"],
  ["28", "MS", "Mississippi"],
  ["29", "MO", "Missouri"],
  ["30", "MT", "Montana"],
  ["31", "NE", "Nebraska"],
  ["32", "NV", "Nevada"],
  ["33", "NH", "New Hampshire"],
  ["34", "NJ", "New Jersey"],
  ["35", "NM", "New Mexico"],
  ["36", "NY", "New York"],
  ["37", "NC", "North Carolina"],
  ["38", "ND", "North Dakota"],
  ["39", "OH", "Ohio"],
  ["40", "OK", "Oklahoma"],
  ["41", "OR", "Oregon"],
  ["42", "PA", "Pennsylvania"],
  ["44", "RI", "Rhode Island"],
  ["45", "SC", "South Carolina"],
  ["46", "SD", "South Dakota"],
  ["47", "TN", "Tennessee"],
  ["48", "TX", "Texas"],
  ["49", "UT", "Utah"],
  ["50", "VT", "Vermont"],
  ["51", "VA", "Virginia"],
  ["53", "WA", "Washington"],
  ["54", "WV", "West Virginia"],
  ["55", "WI", "Wisconsin"],
  ["56", "WY", "Wyoming"],
  ["60", "AS", "American Samoa"],
  ["66", "GU", "Guam"],
  ["69", "MP", "Northern Mariana Islands"],
  ["72", "PR", "Puerto Rico"],
  ["78", "VI", "U.S. Virgin Islands"],
];

const STATE_OF_FIPS = new Map(US_STATES.map(([fips, postal]) => [fips, `US-${postal}`]));
const STATE_OF_NAME = new Map(
  US_STATES.map(([, postal, label]) => [label.toLowerCase(), `US-${postal}`]),
);
const NAME_OF_STATE = new Map(US_STATES.map(([, postal, label]) => [`US-${postal}`, label]));

/** Every country code, in order. */
export const COUNTRY_CODES: readonly string[] = [...COUNTRY_OF_NUMERIC.values()].sort();

/** A country of `world-atlas`: its numeric id, or its name where it has none. */
export function countryOfShape(id: string | number | undefined, name: unknown): string | null {
  if (id !== undefined) return COUNTRY_OF_NUMERIC.get(String(id).padStart(3, "0")) ?? null;
  // It has no ISO code; "XK" is the one in use.
  return name === "Kosovo" ? "XK" : null;
}

/** A state of `us-atlas`, whose ids are FIPS codes. */
export function regionOfShape(fips: string | number | undefined): string | null {
  return fips === undefined ? null : (STATE_OF_FIPS.get(String(fips).padStart(2, "0")) ?? null);
}

/** DB-IP Lite names a region and gives it no code: known for the United States. */
export function regionOfName(country: string, name: string): string | null {
  return country === "US" ? (STATE_OF_NAME.get(name.trim().toLowerCase()) ?? null) : null;
}

export function countryCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** "US-CA", or "CA" inside its country. */
export function regionCode(value: unknown, country: string): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  const full = code.includes("-") ? code : `${country}-${code}`;
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(full) && full.startsWith(`${country}-`) ? full : null;
}

let countryNames: Intl.DisplayNames | undefined;

/** A code as people read it. */
export function placeName(code: string): string {
  if (code.includes("-")) return NAME_OF_STATE.get(code) ?? code;
  countryNames ??= new Intl.DisplayNames("en", { type: "region" });
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}
