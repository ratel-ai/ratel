import { tool } from "ai";
import { z } from "zod";

export const recruitingTools = {
  createJobPosting: tool({
    description:
      'Create a new job posting with title, description, requirements, and salary range.',
    inputSchema: z.object({
      title: z.string().describe("Job title"),
      department: z.string().describe("Department"),
      description: z.string().describe("Job description"),
      requirements: z
        .array(z.string())
        .optional()
        .describe("Required qualifications"),
      salaryMin: z.number().optional().describe("Minimum salary"),
      salaryMax: z.number().optional().describe("Maximum salary"),
    }),
  }),
  listCandidates: tool({
    description:
      'List candidates for a job posting or search across all candidates',
    inputSchema: z.object({
      jobPostingId: z.string().optional().describe("Filter by job posting (if not provided, all job postings are returned. This is the default behavior)"),
      status: z
        .enum(["applied", "screening", "interviewing", "offered", "hired", "rejected"])
        .optional()
        .describe("Filter by status (if not provided, all statuses are returned. This is the default behavior)"),
    }),
  }),
  scheduleInterview: tool({
    description:
      'Schedule an interview with a candidate.',
    inputSchema: z.object({
      candidateId: z.string().describe("Candidate ID"),
      interviewerId: z.string().describe("Interviewer employee ID"),
      date: z.string().describe("Interview date (YYYY-MM-DD)"),
      time: z.string().describe("Interview time (HH:MM)"),
      timezone: z.string().optional().describe("Interview date/time timezone (e.g. CET)"),
      type: z
        .enum(["phone", "video", "onsite"])
        .optional()
        .describe("Interview type"),
    }),
  }),
  sendOffer: tool({
    description:
      'Send a job offer to a candidate with compensation details.',
    inputSchema: z.object({
      candidateId: z.string().describe("Candidate ID"),
      salary: z.number().describe("Offered salary"),
      startDate: z.string().describe("Proposed start date (YYYY-MM-DD)"),
      benefits: z.array(z.string()).optional().describe("Included benefits"),
    }),
  }),
  rejectCandidate: tool({
    description:
      'Reject a candidate with a reason.',
    inputSchema: z.object({
      candidateId: z.string().describe("Candidate ID"),
      reason: z.string().describe("Rejection reason"),
      sendNotification: z
        .boolean()
        .optional()
        .describe("Send rejection email"),
    }),
  }),
  getJobPostings: tool({
    description:
      'List all open job postings.',
    inputSchema: z.object({
      department: z.string().optional().describe("Filter by department"),
      status: z
        .enum(["open", "closed", "draft"])
        .optional()
        .describe("Filter by status"),
    }),
  }),
  getCandidateProfile: tool({
    description:
      'Get detailed profile of a candidate.',
    inputSchema: z.object({
      candidateId: z.string().describe("Candidate ID"),
    }),
  }),
  getApplicationStatus: tool({
    description:
      'Get the current application status for a candidate across all job postings.',
    inputSchema: z.object({
      candidateId: z.string().describe("Candidate ID"),
    }),
  }),
};
