import { useState } from "react";
import Auth from "./components/Auth/Auth";
import { logout } from "./auth/auth";

function Dashboard({ user, onLogout }) {
  return (
    <div style={{ padding: 20, fontFamily: "Arial" }}>
      <h2>Accounting Dashboard</h2>
      <p>
        Logged in as: <b>{user.name || user.email}</b> ({user.role})
      </p>
      <button onClick={onLogout}>Logout</button>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);

  if (!user) return <Auth onAuthed={setUser} />;

  return (
    <Dashboard
      user={user}
      onLogout={() => {
        logout();
        setUser(null);
      }}
    />
  );
}