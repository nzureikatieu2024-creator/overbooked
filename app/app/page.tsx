import { redirect } from "next/navigation";
import Planner from "@/components/Planner";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Planner — Overbooked" };

export default async function AppPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <Planner />;
}
