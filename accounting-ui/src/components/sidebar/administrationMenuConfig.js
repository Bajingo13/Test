// Data-driven Administration navigation tree - same NavTree.jsx renderer
// File Setup/Transactions/Reports use. Every page here does its own
// backend-permission self-check on mount (calls GET /api/me/permissions)
// and shows an access-denied message if not granted - this menu doesn't
// filter itself by role/permission yet (that's Phase 6's sidebar-wide
// permission filtering), it just makes these routes discoverable.
import { Users, Mail } from "lucide-react";

export const ADMINISTRATION_MENU = [
  { id: "user-settings", label: "User Settings", icon: Users, path: "/admin/user-settings" },
  { id: "invitations", label: "Invitations", icon: Mail, path: "/admin/invitations" },
];
