import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOB_SAMPLES,
  BLOB_WOBBLE,
  blobOutline,
  blobPointAt,
  blobReach,
  hashId,
  hullRadii,
  pointInPolygon,
  polygonsMeet,
  seededRandom,
  signedDistance,
  smoothClosedCurve,
  wobble,
} from "@/lib/views/intents/map/map-blobs";

const centre = { x: 200, y: 150 };
const body = { ...centre, r: 40 };

test("a group's wobble is seeded by its id: the same every time, different between groups", () => {
  assert.equal(hashId("intent_63"), hashId("intent_63"));
  assert.notEqual(hashId("intent_63"), hashId("intent_64"));
  const first = seededRandom(7);
  const again = seededRandom(7);
  assert.deepEqual([first(), first(), first()], [again(), again(), again()]);
  const noise = wobble("intent_63");
  assert.deepEqual(noise, wobble("intent_63"), "no jitter between renders");
  assert.notDeepEqual(noise, wobble("intent_64"));
  assert.equal(noise.length, BLOB_SAMPLES);
  assert.equal(Math.min(...noise), 0);
  assert.equal(Math.max(...noise), 1);
  // Smooth: neighbouring samples never jump.
  for (let index = 0; index < noise.length; index += 1) {
    assert.ok(Math.abs(noise[index]! - noise[(index + 1) % noise.length]!) < 0.35);
  }
});

test("the blob path is deterministic per id and inputs", () => {
  const discs = [body, { x: 248, y: 150, r: 11 }];
  const a = blobOutline("intent_63", centre, discs);
  assert.equal(
    a.path,
    blobOutline("intent_63", centre, discs).path,
    "same id, same shape, every render and re-layout",
  );
  assert.notEqual(
    a.path,
    blobOutline("intent_64", centre, discs).path,
    "another group wobbles its own way",
  );
  assert.match(
    a.path,
    /^M[\d.-]+,[\d.-]+(C[\d., -]+)+Z$/,
    "a smooth closed curve of cubic segments",
  );
  assert.equal(a.points.length, BLOB_SAMPLES);
});

test("a blob only wobbles outward, by a few percent of its radius", () => {
  const blob = blobOutline("intent_0", centre, [body]);
  const ratios = blob.radii.map((radius) => radius / body.r);
  assert.ok(Math.min(...ratios) >= 1, "never inside the hull");
  assert.ok(Math.max(...ratios) <= 1 + BLOB_WOBBLE + 0.02, "a few percent at most");
  assert.ok(
    Math.max(...ratios) - Math.min(...ratios) >= BLOB_WOBBLE * 0.9,
    "but it does wobble: not a perfect circle",
  );
  assert.ok(Math.abs(blobReach(blob) - Math.max(...blob.radii)) < 1e-9);
});

test("the hull holds every disc it is drawn around", () => {
  const radii = hullRadii(centre, [body, { x: 300, y: 150, r: 10 }]);
  assert.ok(radii[0]! >= 110 - 1e-6, "reaches the far disc's edge straight out");
  assert.ok(Math.abs(radii[BLOB_SAMPLES / 2]! - 40) < 0.01, "and only the body on the other side");
});

test("the drawn curve encloses everything the blob holds, near and far", () => {
  const cases = [
    { id: "intent_1", discs: [body] },
    { id: "intent_2", discs: [body, { x: 245, y: 165, r: 12 }, { x: 160, y: 190, r: 9 }] },
    // A shared tool a little past the body, and one far out (the blob bulges to hold it).
    { id: "intent_3", discs: [body, { x: 260, y: 120, r: 13 }, { x: 200, y: 300, r: 11 }] },
  ];
  for (const { id, discs } of cases) {
    const blob = blobOutline(id, centre, discs);
    // The path's own curve, finely: what the reader sees.
    const curve = smoothClosedCurve(blob.points, 24);
    for (const disc of discs) {
      assert.ok(pointInPolygon(disc, curve), `${id}: the centre of a held disc is inside`);
      assert.ok(
        signedDistance(disc, curve) >= disc.r - 0.05,
        `${id}: the whole disc is inside, not on the outline`,
      );
    }
  }
});

test("a point on the outline at an angle, and polygon tests", () => {
  const circle = blobOutline("intent_9", centre, [body]);
  const top = blobPointAt(circle, -Math.PI / 2);
  assert.ok(Math.abs(top.x - centre.x) < 1e-6);
  assert.ok(top.y < centre.y - 39.9 && top.y > centre.y - 40 * (1 + BLOB_WOBBLE) - 2);
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.ok(pointInPolygon({ x: 5, y: 5 }, square));
  assert.ok(!pointInPolygon({ x: 15, y: 5 }, square));
  assert.equal(signedDistance({ x: 5, y: 5 }, square), 5, "positive inside");
  assert.equal(signedDistance({ x: 13, y: 5 }, square), -3, "negative outside");
  const shifted = (dx: number) => square.map((point) => ({ x: point.x + dx, y: point.y }));
  assert.ok(polygonsMeet(square, shifted(8)), "overlapping squares meet");
  assert.ok(!polygonsMeet(square, shifted(12)), "apart ones do not");
  assert.ok(
    polygonsMeet(square, [
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 5, y: 6 },
    ]),
    "one inside the other meets",
  );
});
