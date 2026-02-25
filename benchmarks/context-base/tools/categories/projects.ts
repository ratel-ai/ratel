import { tool } from "ai";
import { z } from "zod";

export const projectsTools = {
  createProject: tool({
    description: "Create a new project with timeline and team assignment.",
    inputSchema: z.object({
      name: z.string().describe("Project name"),
      description: z.string().describe("Project description"),
      ownerId: z.string().describe("Project owner employee ID"),
      startDate: z.string().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("Target end date (YYYY-MM-DD)"),
      budget: z.number().optional().describe("Project budget"),
    }),
  }),
  getProject: tool({
    description: "Get project details by project ID.",
    inputSchema: z.object({
      projectId: z.string().describe("Project ID"),
    }),
  }),
  listProjects: tool({
    description: "List projects with optional filters by status or owner.",
    inputSchema: z.object({
      status: z.enum(["planning", "active", "on-hold", "completed", "cancelled", "all"]).optional().describe("Status filter"),
      ownerId: z.string().optional().describe("Filter by project owner"),
    }),
  }),
  updateProject: tool({
    description: "Update project details, status, or timeline.",
    inputSchema: z.object({
      projectId: z.string().describe("Project ID"),
      status: z.enum(["planning", "active", "on-hold", "completed", "cancelled"]).optional().describe("New status"),
      endDate: z.string().optional().describe("Updated end date"),
      budget: z.number().optional().describe("Updated budget"),
    }),
  }),
  createTask: tool({
    description: "Create a task within a project.",
    inputSchema: z.object({
      projectId: z.string().describe("Parent project ID"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description"),
      assigneeId: z.string().optional().describe("Assignee employee ID"),
      dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Task priority"),
    }),
  }),
  getTask: tool({
    description: "Get task details by task ID.",
    inputSchema: z.object({
      taskId: z.string().describe("Task ID"),
    }),
  }),
  listTasks: tool({
    description: "List tasks for a project or assigned to an employee.",
    inputSchema: z.object({
      projectId: z.string().optional().describe("Filter by project"),
      assigneeId: z.string().optional().describe("Filter by assignee"),
      status: z.enum(["todo", "in-progress", "review", "done", "all"]).optional().describe("Status filter"),
    }),
  }),
  updateTask: tool({
    description: "Update a task's status, assignee, or details.",
    inputSchema: z.object({
      taskId: z.string().describe("Task ID"),
      status: z.enum(["todo", "in-progress", "review", "done"]).optional().describe("New status"),
      assigneeId: z.string().optional().describe("New assignee"),
      dueDate: z.string().optional().describe("Updated due date"),
    }),
  }),
  assignTask: tool({
    description: "Assign a project task to a team member.",
    inputSchema: z.object({
      taskId: z.string().describe("Task ID"),
      assigneeId: z.string().describe("Assignee employee ID"),
    }),
  }),
  getMilestones: tool({
    description: "Get milestones for a project with completion status.",
    inputSchema: z.object({
      projectId: z.string().describe("Project ID"),
    }),
  }),
  updateMilestone: tool({
    description: "Update a project milestone's status or target date.",
    inputSchema: z.object({
      milestoneId: z.string().describe("Milestone ID"),
      status: z.enum(["pending", "in-progress", "completed", "missed"]).optional().describe("New status"),
      targetDate: z.string().optional().describe("Updated target date"),
    }),
  }),
  logTimeEntry: tool({
    description: "Log time spent on a project task.",
    inputSchema: z.object({
      taskId: z.string().describe("Task ID"),
      employeeId: z.string().describe("Employee ID"),
      hours: z.number().describe("Hours worked"),
      date: z.string().describe("Work date (YYYY-MM-DD)"),
      description: z.string().optional().describe("Work description"),
    }),
  }),
  getTimesheets: tool({
    description: "Get timesheet entries for an employee or project.",
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Filter by employee"),
      projectId: z.string().optional().describe("Filter by project"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
  }),
  generateProjectReport: tool({
    description: "Generate a project status report with progress, budget, and timeline metrics.",
    inputSchema: z.object({
      projectId: z.string().describe("Project ID"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
  getProjectBudget: tool({
    description: "Get budget details for a project including spent vs. remaining.",
    inputSchema: z.object({
      projectId: z.string().describe("Project ID"),
    }),
  }),
};
