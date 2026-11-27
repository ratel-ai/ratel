"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { SearchInput } from "@ratel/design-system/filter-bar";
import { Field, Input } from "@ratel/design-system/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  type Errors,
  libraryKey,
  type ScorerPick,
  scorerGroups,
} from "@/lib/views/evals/eval-form";
import type { LibraryEntry } from "@/lib/views/evals/scorer-library";

/**
 * The scorers of an eval, from the library (decision `scorer-library`): a picker with search, in
 * two groups, "This project" and "Pre-defined". A pre-defined scorer asks for its settings. A
 * scorer that decides the result of a trial is "gating"; the others only score.
 */
export function ScorerPicker({
  projectId,
  library,
  picks,
  onChange,
  errors,
}: {
  projectId: string;
  library: readonly LibraryEntry[];
  picks: readonly ScorerPick[];
  onChange: (picks: ScorerPick[]) => void;
  errors: Errors;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const byKey = new Map(library.map((entry) => [libraryKey(entry), entry]));
  const groups = scorerGroups(library, search);
  const replace = (index: number, pick: ScorerPick) =>
    onChange(picks.map((one, at) => (at === index ? pick : one)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-xs font-medium text-fg-muted">Scorers</legend>
      {picks.length === 0 ? (
        <p className="text-ui text-fg-subtle">
          No scorer yet. A trial passes when each gating scorer passes.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {picks.map((pick, index) => {
            const entry = byKey.get(pick.key);
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a scorer can be picked twice with other settings; its place is its identity.
                key={`${pick.key}-${index}`}
                className="flex flex-col gap-2 rounded-md border border-line px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">
                    {entry?.name ?? "A scorer that is gone"}
                  </span>
                  <Badge tone="neutral">
                    {entry?.source === "predefined" ? "Pre-defined" : "This project"}
                  </Badge>
                  <Switch
                    label="Gating"
                    checked={pick.gating}
                    onCheckedChange={(gating) => replace(index, { ...pick, gating })}
                  />
                  <IconButton
                    label="Remove the scorer"
                    size="icon-sm"
                    icon={<X aria-hidden />}
                    onClick={() => onChange(picks.filter((_, at) => at !== index))}
                  />
                </div>
                {entry?.settings.map((setting) => (
                  <Field
                    key={setting.name}
                    label={setting.description}
                    error={errors[`scorer.${pick.key}.${setting.name}`]}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        type={setting.type === "number" ? "number" : "text"}
                        value={pick.settings[setting.name] ?? ""}
                        onChange={(event) =>
                          replace(index, {
                            ...pick,
                            settings: { ...pick.settings, [setting.name]: event.target.value },
                          })
                        }
                      />
                    )}
                  </Field>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button size="sm" />}>
            <Plus aria-hidden /> Add scorer
          </PopoverTrigger>
          <PopoverContent className="flex w-96 flex-col gap-2 p-2">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search scorers"
              label="Search scorers"
              className="max-w-none"
            />
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {groups.map((group) => (
                <fieldset key={group.label} className="flex flex-col">
                  <legend className="px-2 py-1 text-xs font-medium text-fg-subtle">
                    {group.label}
                  </legend>
                  {group.entries.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-fg-faint">
                      {group.label === "This project" && search === ""
                        ? "The project has no scorer yet."
                        : "No scorer matches."}
                    </p>
                  ) : (
                    group.entries.map((entry) => (
                      <button
                        key={libraryKey(entry)}
                        type="button"
                        disabled={!entry.usable}
                        title={entry.why ?? undefined}
                        onClick={() => {
                          onChange([
                            ...picks,
                            { key: libraryKey(entry), gating: true, settings: {} },
                          ]);
                          setOpen(false);
                          setSearch("");
                        }}
                        className="flex flex-col items-start rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="flex items-center gap-2 text-ui text-fg">
                          {entry.name}
                          <span className="text-xs text-fg-subtle">
                            {entry.kind === "judge" ? "Judged" : "Check"}
                          </span>
                        </span>
                        <span className="text-xs text-fg-subtle">
                          {entry.usable ? entry.description : entry.why}
                        </span>
                      </button>
                    ))
                  )}
                </fieldset>
              ))}
            </div>
            <Link
              href={`/project/${projectId}/scorers/new`}
              target="_blank"
              className="border-t border-line px-2 pt-2 pb-1 text-ui text-accent-mark hover:underline"
            >
              Create a scorer
            </Link>
          </PopoverContent>
        </Popover>
      </div>
      {errors.scorers ? <p className="text-xs text-danger">{errors.scorers}</p> : null}
    </fieldset>
  );
}
