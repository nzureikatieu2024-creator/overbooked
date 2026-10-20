"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LogoutButton() {
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await createClient().auth.signOut();
    window.location.assign("/");
  }

  return (
    <button type="button" className="btn btn-secondary" data-testid="logout" onClick={logout} disabled={busy}>
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}
