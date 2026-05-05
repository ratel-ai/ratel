interface StatCardProps {
  label: string;
  value: number | string;
  color?: "default" | "success" | "warning" | "info";
}

export function StatCard({ label, value, color = "default" }: StatCardProps) {
  return (
    <div className={`stat-card stat-card--${color}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
