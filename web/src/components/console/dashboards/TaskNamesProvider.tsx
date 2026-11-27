"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * The task names of a page by id (RTL-397): RQL groups by a task's id, and a widget grouped by
 * task shows its name. A page reads them once with its form data; outside a provider there are none.
 */

type TaskNames = Readonly<Record<string, string>>;

const TaskNamesContext = createContext<TaskNames>({});

export function TaskNamesProvider({ names, children }: { names: TaskNames; children: ReactNode }) {
  return <TaskNamesContext value={names}>{children}</TaskNamesContext>;
}

/** The page's task names; none outside a provider. */
export function useTaskNames(): TaskNames {
  return useContext(TaskNamesContext);
}
