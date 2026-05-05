import type { Employee } from "../types/hr";

interface EmployeeCardProps {
  employee: Employee;
  onClick: () => void;
  onDelete: () => void;
}

export function EmployeeCard({ employee, onClick, onDelete }: EmployeeCardProps) {
  const statusColors = {
    active: "status--active",
    inactive: "status--inactive",
    onboarding: "status--onboarding",
  };

  return (
    <div className="employee-card" onClick={onClick}>
      <div className="employee-card-avatar">
        {employee.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
      </div>
      <div className="employee-card-info">
        <div className="employee-card-name">{employee.name}</div>
        <div className="employee-card-role">{employee.role}</div>
        <div className="employee-card-meta">
          <span className="employee-card-dept">{employee.department}</span>
          <span className={`employee-card-status ${statusColors[employee.status]}`}>
            {employee.status}
          </span>
        </div>
      </div>
      <button
        className="employee-card-delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Deactivate"
      >
        &times;
      </button>
    </div>
  );
}
