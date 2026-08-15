import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Notifications moved into Settings. Keep this route so existing links resolve.
export default async function NotificationsPage() {
  redirect("/settings?section=notifications");
}
