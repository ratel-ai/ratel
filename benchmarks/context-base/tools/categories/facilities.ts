import { tool } from "ai";
import { z } from "zod";

export const facilitiesTools = {
  bookRoom: tool({
    description: "Book a meeting room for a specific date and time.",
    inputSchema: z.object({
      roomId: z.string().describe("Room ID"),
      date: z.string().describe("Date (YYYY-MM-DD)"),
      startTime: z.string().describe("Start time (HH:MM)"),
      endTime: z.string().describe("End time (HH:MM)"),
      organizerId: z.string().describe("Organizer employee ID"),
      title: z.string().optional().describe("Meeting title"),
    }),
  }),
  listRooms: tool({
    description: "List available meeting rooms with capacity and amenities info.",
    inputSchema: z.object({
      floor: z.number().optional().describe("Filter by floor number"),
      minCapacity: z.number().optional().describe("Minimum room capacity"),
      amenities: z.array(z.string()).optional().describe("Required amenities (e.g. projector, whiteboard)"),
    }),
  }),
  cancelRoomBooking: tool({
    description: "Cancel a meeting room booking.",
    inputSchema: z.object({
      bookingId: z.string().describe("Booking ID"),
      reason: z.string().optional().describe("Cancellation reason"),
    }),
  }),
  getRoomSchedule: tool({
    description: "Get the schedule/availability for a specific meeting room.",
    inputSchema: z.object({
      roomId: z.string().describe("Room ID"),
      date: z.string().describe("Date (YYYY-MM-DD)"),
    }),
  }),
  requestEquipment: tool({
    description: "Request office equipment (desk, chair, monitor stand, etc.).",
    inputSchema: z.object({
      employeeId: z.string().describe("Requesting employee ID"),
      equipmentType: z.string().describe("Equipment type"),
      quantity: z.number().optional().describe("Quantity needed"),
      justification: z.string().optional().describe("Request justification"),
    }),
  }),
  getEquipmentStatus: tool({
    description: "Get the status of an equipment request.",
    inputSchema: z.object({
      requestId: z.string().describe("Equipment request ID"),
    }),
  }),
  submitMaintenanceRequest: tool({
    description: "Submit a facilities maintenance request (HVAC, plumbing, electrical, etc.).",
    inputSchema: z.object({
      location: z.string().describe("Building/floor/room location"),
      issueType: z.enum(["hvac", "plumbing", "electrical", "cleaning", "furniture", "other"]).describe("Issue type"),
      description: z.string().describe("Issue description"),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Priority level"),
      reporterId: z.string().describe("Reporter employee ID"),
    }),
  }),
  getMaintenanceStatus: tool({
    description: "Get status of a maintenance request.",
    inputSchema: z.object({
      requestId: z.string().describe("Maintenance request ID"),
    }),
  }),
  listMaintenanceRequests: tool({
    description: "List maintenance requests with optional filters.",
    inputSchema: z.object({
      status: z.enum(["open", "in-progress", "completed", "all"]).optional().describe("Status filter"),
      location: z.string().optional().describe("Filter by location"),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Priority filter"),
    }),
  }),
  getFloorPlan: tool({
    description: "Get floor plan layout with desk and room assignments.",
    inputSchema: z.object({
      building: z.string().optional().describe("Building name"),
      floor: z.number().optional().describe("Floor number"),
    }),
  }),
  reserveDesk: tool({
    description: "Reserve a hot desk for a specific date.",
    inputSchema: z.object({
      deskId: z.string().describe("Desk ID"),
      employeeId: z.string().describe("Employee ID"),
      date: z.string().describe("Reservation date (YYYY-MM-DD)"),
    }),
  }),
  generateFacilitiesReport: tool({
    description: "Generate a facilities utilization and maintenance report.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      building: z.string().optional().describe("Filter by building"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
