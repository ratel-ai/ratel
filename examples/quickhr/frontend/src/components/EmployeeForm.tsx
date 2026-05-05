import { useState, type FormEvent } from "react";
import type { Employee } from "../types/hr";

interface EmployeeFormProps {
  employee?: Employee;
  prefill?: Record<string, string> | null;
  onSubmit: (data: Omit<Employee, "id" | "status">) => void;
  onCancel: () => void;
}

export function EmployeeForm({ employee, prefill, onSubmit, onCancel }: EmployeeFormProps) {
  const [name, setName] = useState(employee?.name || prefill?.name || "");
  const [email, setEmail] = useState(employee?.email || prefill?.email || "");
  const [role, setRole] = useState(employee?.role || prefill?.role || "");
  const [department, setDepartment] = useState(employee?.department || prefill?.department || "Engineering");
  const [startDate, setStartDate] = useState(employee?.startDate || prefill?.startDate || "");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ name, email, role, department, startDate, managerId: null });
  };

  return (
    <form className="employee-form" onSubmit={handleSubmit}>
      <div className="form-field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="form-field">
        <label htmlFor="role">Role</label>
        <input
          id="role"
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          required
        />
      </div>
      <div className="form-field">
        <label htmlFor="department">Department</label>
        <select
          id="department"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
        >
          <option value="Engineering">Engineering</option>
          <option value="Product">Product</option>
          <option value="Design">Design</option>
          <option value="Sales">Sales</option>
          <option value="Finance">Finance</option>
          <option value="HR">HR</option>
          <option value="Executive">Executive</option>
        </select>
      </div>
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
      <div className="form-actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary">
          {employee ? "Update" : "Add"} Employee
        </button>
      </div>
    </form>
  );
}
