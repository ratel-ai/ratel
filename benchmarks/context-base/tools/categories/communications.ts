import { tool } from "ai";
import { z } from "zod";

export const communicationsTools = {
  sendAnnouncement: tool({
    description: "Send a company-wide or department announcement.",
    inputSchema: z.object({
      title: z.string().describe("Announcement title"),
      content: z.string().describe("Announcement content"),
      audience: z.enum(["all", "department", "team"]).optional().describe("Target audience"),
      department: z.string().optional().describe("Target department (if audience=department)"),
      senderId: z.string().describe("Sender employee ID"),
    }),
  }),
  getAnnouncement: tool({
    description: "Get announcement details by announcement ID.",
    inputSchema: z.object({
      announcementId: z.string().describe("Announcement ID"),
    }),
  }),
  listAnnouncements: tool({
    description: "List recent announcements with optional filters.",
    inputSchema: z.object({
      audience: z.enum(["all", "department", "team"]).optional().describe("Audience filter"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      limit: z.number().optional().describe("Max results"),
    }),
  }),
  createSurvey: tool({
    description: "Create an employee survey or poll.",
    inputSchema: z.object({
      title: z.string().describe("Survey title"),
      description: z.string().describe("Survey description"),
      questions: z.array(z.object({
        text: z.string(),
        type: z.enum(["multiple-choice", "text", "rating", "yes-no"]),
        options: z.array(z.string()).optional(),
      })).describe("Survey questions"),
      deadline: z.string().optional().describe("Response deadline (YYYY-MM-DD)"),
      anonymous: z.boolean().optional().describe("Whether responses are anonymous"),
    }),
  }),
  getSurvey: tool({
    description: "Get survey details by survey ID.",
    inputSchema: z.object({
      surveyId: z.string().describe("Survey ID"),
    }),
  }),
  listSurveys: tool({
    description: "List surveys with optional status filter.",
    inputSchema: z.object({
      status: z.enum(["active", "closed", "draft", "all"]).optional().describe("Status filter"),
    }),
  }),
  getSurveyResults: tool({
    description: "Get aggregated results for a completed survey.",
    inputSchema: z.object({
      surveyId: z.string().describe("Survey ID"),
    }),
  }),
  submitSurveyResponse: tool({
    description: "Submit a response to an active survey.",
    inputSchema: z.object({
      surveyId: z.string().describe("Survey ID"),
      respondentId: z.string().optional().describe("Respondent employee ID (if not anonymous)"),
      answers: z.array(z.object({ questionId: z.string(), answer: z.string() })).describe("Survey answers"),
    }),
  }),
  createNewsletter: tool({
    description: "Create an internal newsletter.",
    inputSchema: z.object({
      title: z.string().describe("Newsletter title"),
      content: z.string().describe("Newsletter content (HTML or markdown)"),
      scheduledDate: z.string().optional().describe("Scheduled send date (YYYY-MM-DD)"),
    }),
  }),
  getNewsletter: tool({
    description: "Get newsletter details by newsletter ID.",
    inputSchema: z.object({
      newsletterId: z.string().describe("Newsletter ID"),
    }),
  }),
  sendNewsletter: tool({
    description: "Send a newsletter to all employees or a specific audience.",
    inputSchema: z.object({
      newsletterId: z.string().describe("Newsletter ID"),
      audience: z.enum(["all", "department", "team"]).optional().describe("Target audience"),
      department: z.string().optional().describe("Target department (if audience=department)"),
    }),
  }),
  generateCommunicationsReport: tool({
    description: "Generate a report on internal communications engagement metrics.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
