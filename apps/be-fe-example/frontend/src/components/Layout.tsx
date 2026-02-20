import { Link, Outlet } from "react-router-dom";
import { ChatWidget } from "./ChatWidget";

export function Layout() {
  return (
    <div>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/contact">Contact</Link>
      </nav>
      <main>
        <Outlet />
      </main>
      <ChatWidget />
    </div>
  );
}
