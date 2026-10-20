import ResetPasswordForm from "@/components/ResetPasswordForm";

// The URL carries a one-time recovery code: keep it out of search engines and referrers.
export const metadata = {
  title: "Choose a new password — Overbooked",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
