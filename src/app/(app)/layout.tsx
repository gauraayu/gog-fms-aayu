import { AuthProvider } from "@/components/AuthContext";
import { FmsShell } from "@/components/FmsShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <FmsShell>{children}</FmsShell>
    </AuthProvider>
  );
}
