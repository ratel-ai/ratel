"use client";

import { useCallback, useEffect, useState } from "react";

interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/**
 * The published, global skill catalog — exactly what Cloud's
 * `GET /api/v1/catalog` serves and what every end-user's live `SkillCatalog`
 * syncs. (Per-user approved skills stay drafts in Cloud and do NOT appear
 * here — that's the known sync boundary the suggestions panel calls out.)
 */
export function CatalogPanel() {
  const [skills, setSkills] = useState<CatalogSkill[] | null>(null);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/catalog", { cache: "no-store" });
      const data = (await res.json()) as {
        error?: string;
        cloudUrl?: string;
        skills?: CatalogSkill[];
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSkills(data.skills ?? []);
      setCloudUrl(data.cloudUrl ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "catalog fetch failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="panel">
      <h2>
        skill catalog{" "}
        {skills !== null && <span className="count">{skills.length} published</span>}
      </h2>
      <p className="sub">
        synced from{" "}
        {cloudUrl ? (
          <a href={cloudUrl} target="_blank" rel="noreferrer">
            Ratel Cloud
          </a>
        ) : (
          "Ratel Cloud"
        )}{" "}
        into every end-user&apos;s live catalog ·{" "}
        <a
          href="#refresh"
          onClick={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          refresh
        </a>
      </p>
      {error && <div className="status-line error">error: {error}</div>}
      {skills === null && !error && <div className="status-line">loading…</div>}
      {skills?.map((s) => (
        <div key={s.id} className="skill-row">
          <div className="name">{s.name}</div>
          <div className="desc">{s.description}</div>
        </div>
      ))}
      {skills?.length === 0 && (
        <div className="status-line">no published skills — run the seed script</div>
      )}
    </div>
  );
}
