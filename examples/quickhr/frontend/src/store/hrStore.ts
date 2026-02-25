import { create } from "zustand";
import type { Employee, TimeOffRequest, Stats } from "../types/hr";
import * as api from "../api/client";

interface HRStore {
  // State
  employees: Employee[];
  timeOffRequests: TimeOffRequest[];
  stats: Stats | null;
  loading: boolean;
  error: string | null;

  // Employee actions
  fetchEmployees: () => Promise<void>;
  addEmployee: (data: Omit<Employee, "id" | "status">) => Promise<Employee>;
  updateEmployee: (id: string, updates: Partial<Omit<Employee, "id">>) => Promise<void>;
  deleteEmployee: (id: string) => Promise<void>;

  // Time off actions
  fetchTimeOffRequests: () => Promise<void>;
  createTimeOffRequest: (
    data: Omit<TimeOffRequest, "id" | "createdAt" | "status" | "approvedBy">
  ) => Promise<TimeOffRequest>;
  approveTimeOff: (id: string, approvedBy?: string) => Promise<void>;
  rejectTimeOff: (id: string) => Promise<void>;

  // Stats
  fetchStats: () => Promise<void>;

  // Utils
  clearError: () => void;
}

export const useHRStore = create<HRStore>((set) => ({
  employees: [],
  timeOffRequests: [],
  stats: null,
  loading: false,
  error: null,

  fetchEmployees: async () => {
    set({ loading: true, error: null });
    try {
      const { employees } = await api.getEmployees();
      set({ employees, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  addEmployee: async (data) => {
    set({ loading: true, error: null });
    try {
      const employee = await api.createEmployee(data);
      set((s) => ({ employees: [...s.employees, employee], loading: false }));
      return employee;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  updateEmployee: async (id, updates) => {
    set({ loading: true, error: null });
    try {
      const updated = await api.updateEmployee(id, updates);
      set((s) => ({
        employees: s.employees.map((e) => (e.id === id ? updated : e)),
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  deleteEmployee: async (id) => {
    set({ loading: true, error: null });
    try {
      const updated = await api.deleteEmployee(id);
      set((s) => ({
        employees: s.employees.map((e) => (e.id === id ? updated : e)),
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  fetchTimeOffRequests: async () => {
    set({ loading: true, error: null });
    try {
      const { requests } = await api.getTimeOffRequests();
      set({ timeOffRequests: requests, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  createTimeOffRequest: async (data) => {
    set({ loading: true, error: null });
    try {
      const request = await api.createTimeOffRequest(data);
      set((s) => ({
        timeOffRequests: [...s.timeOffRequests, request],
        loading: false,
      }));
      return request;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  approveTimeOff: async (id, approvedBy) => {
    set({ loading: true, error: null });
    try {
      const updated = await api.updateTimeOffStatus(id, "approved", approvedBy);
      set((s) => ({
        timeOffRequests: s.timeOffRequests.map((r) => (r.id === id ? updated : r)),
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  rejectTimeOff: async (id) => {
    set({ loading: true, error: null });
    try {
      const updated = await api.updateTimeOffStatus(id, "rejected");
      set((s) => ({
        timeOffRequests: s.timeOffRequests.map((r) => (r.id === id ? updated : r)),
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  fetchStats: async () => {
    set({ loading: true, error: null });
    try {
      const stats = await api.getStats();
      set({ stats, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
