import { tool } from "ai";
import { z } from "zod";

export const performanceTools = {
  createReview: tool({
    description: "Create a performance review cycle for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      reviewerId: z.string().describe("Reviewer (manager) employee ID"),
      period: z.string().describe("Review period (e.g. H1-2025)"),
      type: z.enum(["annual", "semi-annual", "quarterly", "probation"]).optional().describe("Review type"),
    }),
  }),
  getReview: tool({
    description: "Get performance review details by review ID.",
    inputSchema: z.object({
      reviewId: z.string().describe("Review ID"),
    }),
  }),
  listReviews: tool({
    description: "List performance reviews with optional filters.",
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Filter by employee"),
      reviewerId: z.string().optional().describe("Filter by reviewer"),
      status: z.enum(["draft", "in-progress", "completed", "all"]).optional().describe("Status filter"),
      period: z.string().optional().describe("Filter by period"),
    }),
  }),
  submitSelfAssessment: tool({
    description: "Submit an employee's self-assessment for a performance review.",
    inputSchema: z.object({
      reviewId: z.string().describe("Review ID"),
      employeeId: z.string().describe("Employee ID"),
      achievements: z.string().describe("Key achievements summary"),
      challenges: z.string().optional().describe("Challenges faced"),
      rating: z.number().optional().describe("Self-rating (1-5)"),
    }),
  }),
  submitPeerFeedback: tool({
    description: "Submit peer feedback for a colleague's performance review.",
    inputSchema: z.object({
      reviewId: z.string().describe("Review ID"),
      feedbackFromId: z.string().describe("Feedback giver employee ID"),
      strengths: z.string().describe("Observed strengths"),
      areasForImprovement: z.string().optional().describe("Areas for improvement"),
      rating: z.number().optional().describe("Peer rating (1-5)"),
    }),
  }),
  setGoals: tool({
    description: "Set performance goals for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      goals: z.array(z.object({
        title: z.string(),
        description: z.string(),
        dueDate: z.string(),
        weight: z.number().optional(),
      })).describe("Goals to set"),
      period: z.string().describe("Goal period (e.g. H1-2025)"),
    }),
  }),
  getGoals: tool({
    description: "Get current performance goals for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      period: z.string().optional().describe("Filter by period"),
    }),
  }),
  updateGoalProgress: tool({
    description: "Update progress on a specific performance goal.",
    inputSchema: z.object({
      goalId: z.string().describe("Goal ID"),
      progress: z.number().describe("Progress percentage (0-100)"),
      notes: z.string().optional().describe("Progress notes"),
    }),
  }),
  createOKR: tool({
    description: "Create an OKR (Objectives and Key Results) for an employee or team.",
    inputSchema: z.object({
      ownerId: z.string().describe("OKR owner employee ID"),
      objective: z.string().describe("Objective statement"),
      keyResults: z.array(z.object({
        description: z.string(),
        targetValue: z.number(),
        unit: z.string(),
      })).describe("Key results"),
      period: z.string().describe("OKR period (e.g. Q1-2025)"),
    }),
  }),
  getOKRs: tool({
    description: "Get OKRs for an employee or team.",
    inputSchema: z.object({
      ownerId: z.string().optional().describe("Filter by owner"),
      period: z.string().optional().describe("Filter by period"),
    }),
  }),
  requestFeedback: tool({
    description: "Request feedback from colleagues for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee requesting feedback"),
      reviewerIds: z.array(z.string()).describe("Employee IDs to request feedback from"),
      context: z.string().optional().describe("Context for the feedback request"),
    }),
  }),
  generatePerformanceReport: tool({
    description: "Generate a performance analytics report across the organization.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. H1-2025)"),
      department: z.string().optional().describe("Filter by department"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
