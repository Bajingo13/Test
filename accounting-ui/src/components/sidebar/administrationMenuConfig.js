// Data-driven Administration navigation tree - same NavTree.jsx renderer
// File Setup/Transactions/Reports use. Every page here does its own
// backend-permission self-check on mount (calls GET /api/me/permissions)
// and shows an access-denied message if not granted - this menu doesn't
// filter itself by role/permission yet (that's Phase 6's sidebar-wide
// permission filtering), it just makes these routes discoverable.
import { Users, Mail, ShieldCheck, Lock, LayoutTemplate, CalendarClock } from "lucide-react";

export const ADMINISTRATION_MENU = [
  { id: "user-settings", label: "User Settings", icon: Users, path: "/admin/user-settings" },
  { id: "invitations", label: "Invitations", icon: Mail, path: "/admin/invitations" },
  { id: "roles-permissions", label: "Roles and Permissions", icon: ShieldCheck, path: "/admin/roles-permissions" },
  { id: "access-restrictions", label: "Access Restrictions", icon: Lock, path: "/admin/access-restrictions" },
  { id: "permission-templates", label: "Permission Templates", icon: LayoutTemplate, path: "/admin/permission-templates" },
  { id: "accounting-period-locking", label: "Accounting Period Locking", icon: CalendarClock, path: "/admin/accounting-period-locking" },
];
