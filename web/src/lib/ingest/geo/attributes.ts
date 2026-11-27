/** Where a project's traces carry their location. Safe for the browser. */

export interface GeoAttributes {
  /** An IP address: resolved, never stored. */
  address: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** ISO 3166-2, or its part after the country. */
  region: string;
  latitude: string;
  longitude: string;
}

export const GEO_ATTRIBUTES = ["address", "country", "region", "latitude", "longitude"] as const;

export const DEFAULT_GEO_ATTRIBUTES: GeoAttributes = {
  address: "client.address",
  country: "geo.country.iso_code",
  region: "geo.region.iso_code",
  latitude: "geo.location.lat",
  longitude: "geo.location.lon",
};
