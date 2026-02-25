import { tool } from "ai";
import { z } from "zod";

export const onboardingTools = {
  startOnboarding: tool({
    description:
      'Initiate the onboarding workflow for a new employee. Creates checklist and assigns tasks.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    }),
  }),
  assignRole: tool({
    description:
      'Assign a role and permissions to an employee in the system.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      role: z.string().describe("Role name"),
      permissions: z
        .array(z.string())
        .optional()
        .describe("Additional permissions"),
    }),
  }),
  sendWelcomeEmail: tool({
    description:
      'Send welcome email with onboarding instructions to new employee.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      customMessage: z.string().optional().describe("Custom message to include"),
    }),
  }),
  scheduleOrientation: tool({
    description:
      'Schedule orientation session for a new employee.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      date: z.string().describe("Orientation date (YYYY-MM-DD)"),
      format: z
        .enum(["in-person", "remote"])
        .optional()
        .describe("Session format"),
    }),
  }),
  assignMentor: tool({
    description:
      'Assign a mentor to a new employee for their onboarding period.',
    inputSchema: z.object({
      employeeId: z.string().describe("New employee ID"),
      mentorId: z.string().describe("Mentor employee ID"),
      durationWeeks: z
        .number()
        .optional()
        .describe("Mentorship duration in weeks"),
    }),
  }),
  getOnboardingStatus: tool({
    description:
      'Get the current onboarding checklist status for an employee.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  getOnboardingChecklist: tool({
    description:
      'Get the full onboarding checklist template for a role.',
    inputSchema: z.object({
      role: z.string().describe("Role name"),
      department: z.string().optional().describe("Department name"),
    }),
  }),
  completeOnboardingTask: tool({
    description:
      'Mark a specific onboarding task as completed.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      taskId: z.string().describe("Onboarding task ID"),
    }),
  }),
};
