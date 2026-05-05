import { tool } from "ai";
import { z } from "zod";

export const trainingTools = {
  createCourse: tool({
    description: "Create a new training course in the learning management system.",
    inputSchema: z.object({
      title: z.string().describe("Course title"),
      description: z.string().describe("Course description"),
      category: z.string().describe("Course category (e.g. compliance, technical, leadership)"),
      durationHours: z.number().describe("Estimated duration in hours"),
      mandatory: z.boolean().optional().describe("Whether the course is mandatory"),
    }),
  }),
  getCourse: tool({
    description: "Get training course details by course ID.",
    inputSchema: z.object({
      courseId: z.string().describe("Course ID"),
    }),
  }),
  listCourses: tool({
    description: "List available training courses with optional filters.",
    inputSchema: z.object({
      category: z.string().optional().describe("Filter by category"),
      mandatory: z.boolean().optional().describe("Filter mandatory courses"),
    }),
  }),
  enrollInCourse: tool({
    description: "Enroll an employee in a training course.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      courseId: z.string().describe("Course ID"),
      dueDate: z.string().optional().describe("Completion due date (YYYY-MM-DD)"),
    }),
  }),
  listCourseEnrollments: tool({
    description: "List course enrollments for an employee, showing which courses they are enrolled in and their completion status.",
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Filter by employee ID"),
      status: z.enum(["enrolled", "in-progress", "completed", "all"]).optional().describe("Filter by enrollment status"),
    }),
  }),
  getCourseProgress: tool({
    description: "Get an employee's progress in a specific training course.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      courseId: z.string().describe("Course ID"),
    }),
  }),
  completeCourse: tool({
    description: "Mark a training course as completed for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      courseId: z.string().describe("Course ID"),
      score: z.number().optional().describe("Final assessment score"),
    }),
  }),
  getCertification: tool({
    description: "Get certification details for an employee.",
    inputSchema: z.object({
      certificationId: z.string().describe("Certification ID"),
    }),
  }),
  listCertifications: tool({
    description: "List certifications for an employee or across the organization.",
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Filter by employee"),
      status: z.enum(["active", "expired", "pending-renewal", "all"]).optional().describe("Status filter"),
    }),
  }),
  renewCertification: tool({
    description: "Initiate renewal process for an expiring certification.",
    inputSchema: z.object({
      certificationId: z.string().describe("Certification ID"),
      employeeId: z.string().describe("Employee ID"),
      renewalDate: z.string().describe("Renewal date (YYYY-MM-DD)"),
    }),
  }),
  createAssessment: tool({
    description: "Create a training assessment or quiz for a course.",
    inputSchema: z.object({
      courseId: z.string().describe("Associated course ID"),
      title: z.string().describe("Assessment title"),
      passingScore: z.number().describe("Minimum passing score (0-100)"),
      questions: z.number().describe("Number of questions"),
    }),
  }),
  submitAssessment: tool({
    description: "Submit an employee's completed assessment with answers.",
    inputSchema: z.object({
      assessmentId: z.string().describe("Assessment ID"),
      employeeId: z.string().describe("Employee ID"),
      answers: z.array(z.object({ questionId: z.string(), answer: z.string() })).describe("Assessment answers"),
    }),
  }),
  getTrainingReport: tool({
    description: "Generate a training completion and compliance report.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      department: z.string().optional().describe("Filter by department"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
