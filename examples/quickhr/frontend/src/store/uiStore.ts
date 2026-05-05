import { create } from "zustand";

type Page = "dashboard" | "employees" | "timeoff";
type TimeOffTab = "requests" | "calendar";

interface UIControlState {
  page: Page;
  setPage: (page: Page) => void;
  employeeModalOpen: boolean;
  employeeModalPrefill: Record<string, string> | null;
  openEmployeeModal: (prefill?: Record<string, string>) => void;
  closeEmployeeModal: () => void;
  timeOffModalOpen: boolean;
  timeOffModalPrefill: Record<string, string> | null;
  openTimeOffModal: (prefill?: Record<string, string>) => void;
  closeTimeOffModal: () => void;
  timeOffTab: TimeOffTab;
  setTimeOffTab: (tab: TimeOffTab) => void;
  calendarMonth: number;
  calendarYear: number;
  setCalendarMonth: (month: number, year: number) => void;
}

export const useUIStore = create<UIControlState>((set) => ({
  page: "dashboard",
  setPage: (page) => set({ page }),
  employeeModalOpen: false,
  employeeModalPrefill: null,
  openEmployeeModal: (prefill) =>
    set({ employeeModalOpen: true, employeeModalPrefill: prefill ?? null }),
  closeEmployeeModal: () =>
    set({ employeeModalOpen: false, employeeModalPrefill: null }),
  timeOffModalOpen: false,
  timeOffModalPrefill: null,
  openTimeOffModal: (prefill) =>
    set({ timeOffModalOpen: true, timeOffModalPrefill: prefill ?? null }),
  closeTimeOffModal: () =>
    set({ timeOffModalOpen: false, timeOffModalPrefill: null }),
  timeOffTab: "requests",
  setTimeOffTab: (tab) => set({ timeOffTab: tab }),
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
  setCalendarMonth: (month, year) => set({ calendarMonth: month, calendarYear: year }),
}));
