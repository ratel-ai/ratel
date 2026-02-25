import { useState, type FormEvent } from "react";
import type { Employee, TimeOffRequest } from "../types/hr";

interface TimeOffFormProps {
  employees: Employee[];
  onSubmit: (data: Omit<TimeOffRequest, "id" | "createdAt" | "status" | "approvedBy">) => void;
  onCancel: () => void;
}

export function TimeOffForm({ employees, onSubmit, onCancel }: TimeOffFormProps) {
  const [employeeId, setEmployeeId] = useState("");
  const [type, setType] = useState<TimeOffRequest["type"]>("vacation");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");

  const selectedEmployee = employees.find((e) => e.id === employeeId);

  const calculateDays = () => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate);
    const end = new Date(endDate);
    return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee) return;
    onSubmit({
      employeeId,
      employeeName: selectedEmployee.name,
      type,
      startDate,
      endDate,
      days: calculateDays(),
      notes: notes || undefined,
    });
  };

  return (
    <form className="timeoff-form" onSubmit={handleSubmit}>
      <div className="form-field">
        <label htmlFor="employee">Employee</label>
        <select
          id="employee"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          required
        >
          <option value="">Select employee...</option>
          {employees.filter((e) => e.status === "active").map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor="type">Type</label>
        <select
          id="type"
          value={type}
          onChange={(e) => setType(e.target.value as TimeOffRequest["type"])}
        >
          <option value="vacation">Vacation</option>
          <option value="sick">Sick Leave</option>
          <option value="personal">Personal</option>
        </select>
      </div>
      <div className="form-row">
        <div className="form-field">
          <label htmlFor="startDate">Start Date</label>
          <input
            id="startDate"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="endDate">End Date</label>
          <input
            id="endDate"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            min={startDate}
            required
          />
        </div>
      </div>
      {startDate && endDate && (
        <div className="form-info">
          <strong>{calculateDays()}</strong> day{calculateDays() !== 1 ? "s" : ""} requested
        </div>
      )}
      <div className="form-field">
        <label htmlFor="notes">Notes (optional)</label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary">
          Submit Request
        </button>
      </div>
    </form>
  );
}
