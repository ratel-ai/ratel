/**
 * The seam where the loop tools tell the lineage spine (RC-45) where an
 * experiment or a shipment came from: one `lineage_links` row per object,
 * which Ship's list and `chainOf` read.
 */
export { type RecordLineageInput, recordLineage } from "@/lib/views/lineage/resolve";
