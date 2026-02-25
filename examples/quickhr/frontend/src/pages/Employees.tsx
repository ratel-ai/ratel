import { useEffect, useState } from "react";
import { useHRStore } from "../store/hrStore";
import { EmployeeCard } from "../components/EmployeeCard";
import { EmployeeForm } from "../components/EmployeeForm";
import { Modal } from "../components/Modal";
import type { Employee } from "../types/hr";

type FilterStatus = "all" | "active" | "onboarding" | "inactive";

export function Employees() {
  const { employees, fetchEmployees, addEmployee, updateEmployee, deleteEmployee, loading } =
    useHRStore();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | undefined>();

  useEffect(() => {
    fetchEmployees();
  }, [fetchEmployees]);

  const filteredEmployees = employees.filter((e) => {
    const matchesSearch =
      e.name.toLowerCase().includes(search.toLowerCase()) ||
      e.email.toLowerCase().includes(search.toLowerCase()) ||
      e.role.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || e.status === filter;
    return matchesSearch && matchesFilter;
  });

  const handleAdd = () => {
    setEditingEmployee(undefined);
    setModalOpen(true);
  };

  const handleEdit = (employee: Employee) => {
    setEditingEmployee(employee);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm("Deactivate this employee?")) {
      await deleteEmployee(id);
    }
  };

  const handleSubmit = async (data: Omit<Employee, "id" | "status">) => {
    if (editingEmployee) {
      await updateEmployee(editingEmployee.id, data);
    } else {
      await addEmployee(data);
    }
    setModalOpen(false);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Employees</h1>
          <p>Manage your team members.</p>
        </div>
        <button className="btn btn--primary" onClick={handleAdd}>
          + Add Employee
        </button>
      </div>

      <div className="employees-toolbar">
        <input
          type="search"
          placeholder="Search by name, email, role..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
        <div className="filter-buttons">
          {(["all", "active", "onboarding", "inactive"] as FilterStatus[]).map((s) => (
            <button
              key={s}
              className={`filter-btn ${filter === s ? "filter-btn--active" : ""}`}
              onClick={() => setFilter(s)}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="loading-state">Loading...</p>
      ) : filteredEmployees.length === 0 ? (
        <p className="empty-state">No employees found</p>
      ) : (
        <div className="employees-list">
          {filteredEmployees.map((e) => (
            <EmployeeCard
              key={e.id}
              employee={e}
              onClick={() => handleEdit(e)}
              onDelete={() => handleDelete(e.id)}
            />
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingEmployee ? "Edit Employee" : "Add Employee"}
      >
        <EmployeeForm
          employee={editingEmployee}
          onSubmit={handleSubmit}
          onCancel={() => setModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
